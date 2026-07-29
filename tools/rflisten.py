#!/usr/bin/env python3
"""
rflisten — convierte TU nodo Meshtastic en un observador independiente.

Para qué: durante un apagón de MQTT, MeshCheck se queda ciego (toda su
observación entra por ese broker). Tu nodo, en cambio, sigue oyendo el aire.
Lo que grabe este script es medición de radio de primera mano: no pasa por
internet en ningún momento, así que nadie puede confundirla con bridging.

Lo decisivo es `hops = hopStart - hopLimit`:
    hops == 0  →  el paquete llegó DIRECTO a tu antena, sin repetidores.
                  Eso, con su SNR, es alcance RF real medido.
    hops > 0   →  también viajó por radio, pero rebotado.

Uso mínimo (solo archivo local):
    pip install meshtastic pypubsub
    python rflisten.py --host 192.168.1.50

Subiendo a MeshCheck (aparece solo en la pestaña RF, en vivo):
    python rflisten.py --host 192.168.1.50 ^
        --rtdb https://TU-PROYECTO-default-rtdb.firebaseio.com ^
        --secret TU_DATABASE_SECRET --label "apagon MQTT"

También sirve por USB:  --port COM3
Ctrl+C cierra ordenado y deja la sesión marcada como terminada.
"""
import argparse, json, math, sys, threading, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--host", help="IP del nodo (interfaz TCP, puerto 4403)")
ap.add_argument("--port", help="puerto serie, p.ej. COM3 o /dev/ttyUSB0")
ap.add_argument("--out", default="rf-captura.jsonl", help="archivo JSONL local")
ap.add_argument("--rtdb", help="URL de la Realtime Database (para que aparezca en la pestaña RF)")
ap.add_argument("--secret", help="database secret, necesario junto con --rtdb")
ap.add_argument("--label", default="captura por radio", help="nombre de la sesión")
ap.add_argument("--every", type=int, default=20, help="segundos entre subidas")
args = ap.parse_args()

import meshtastic
from pubsub import pub

# ------------------------------------------------------------------ estado ---
LOCK = threading.Lock()
links = {}      # "a|b" -> dict            (solo saltos DIRECTOS: RF medido)
nodes = {}      # id    -> dict
timeline = []
start = time.time()
sid = time.strftime("%Y%m%d-%H%M") + "-radio"
my_id = None
seen = directos = indirectos = 0
out = open(args.out, "a", encoding="utf-8")


def hav(a, b):
    """km entre dos nodos con posición conocida."""
    if not a or not b or a.get("lat") is None or b.get("lat") is None:
        return None
    t = math.pi / 180
    dlat, dlon = (b["lat"] - a["lat"]) * t, (b["lon"] - a["lon"]) * t
    s = math.sin(dlat / 2) ** 2 + math.cos(a["lat"] * t) * math.cos(b["lat"] * t) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(s)))


def touch_node(nid, name=None, lat=None, lon=None, role=None):
    now = time.time()
    n = nodes.get(nid) or {"id": nid, "first": now}
    if name:
        n["name"] = name
    if lat is not None:
        n["lat"], n["lon"] = lat, lon
    if role is not None:
        n["role"] = role
    n["last"] = now
    nodes[nid] = n
    return n


def snapshot_nodedb(iface):
    """El nodo mantiene su propia base de vecinos: nombres y posiciones salen de
    ahí, no de internet."""
    try:
        db = getattr(iface, "nodes", None) or {}
    except Exception:
        return
    for _, info in db.items():
        try:
            num = info.get("num")
            if num is None:
                continue
            user = info.get("user") or {}
            pos = info.get("position") or {}
            lat, lon = pos.get("latitude"), pos.get("longitude")
            if lat in (0, None) or lon in (0, None):
                lat = lon = None
            touch_node(str(num), user.get("longName") or user.get("shortName"), lat, lon, user.get("role"))
        except Exception:
            continue


def on_receive(packet, interface=None):
    global seen, directos, indirectos
    try:
        dec = packet.get("decoded") or {}
        hs, hl = packet.get("hopStart"), packet.get("hopLimit")
        hops = (hs - hl) if isinstance(hs, int) and isinstance(hl, int) else None
        src = packet.get("from")
        src_id = str(src) if src is not None else None
        snr, rssi = packet.get("rxSnr"), packet.get("rxRssi")

        rec = {"t": round(time.time(), 3), "from": src_id, "fromId": packet.get("fromId"),
               "to": packet.get("toId") or packet.get("to"), "snr": snr, "rssi": rssi,
               "hops": hops, "hopStart": hs, "hopLimit": hl, "type": dec.get("portnum"),
               "raw": str(packet)[:1500]}
        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
        out.flush()

        with LOCK:
            seen += 1
            if src_id:
                touch_node(src_id)
                # posición si el paquete la trae
                p = dec.get("position") or {}
                la, lo = p.get("latitude"), p.get("longitude")
                if la not in (0, None) and lo not in (0, None):
                    touch_node(src_id, lat=la, lon=lo)
                u = dec.get("user") or {}
                if u.get("longName"):
                    touch_node(src_id, name=u.get("longName"))
            # SOLO los directos son un enlace medido con mi antena
            if hops == 0 and src_id and my_id and src_id != my_id:
                directos += 1
                a, b = (my_id, src_id) if my_id < src_id else (src_id, my_id)
                k = f"{a}|{b}"
                prev = links.get(k)
                best = snr if prev is None or prev.get("snr") is None else (
                    snr if snr is not None and snr > prev["snr"] else prev["snr"])
                links[k] = {"a": a, "b": b, "snr": best, "rssi": rssi, "src": "rf",
                            "first": prev["first"] if prev else time.time(), "last": time.time()}
            elif hops:
                indirectos += 1

        marca = " ← DIRECTO" if hops == 0 else (f"  ({hops} saltos)" if hops else "")
        print(f"{time.strftime('%H:%M:%S')}  {packet.get('fromId') or src_id}  SNR {snr}  RSSI {rssi}  {dec.get('portnum')}{marca}", flush=True)
    except Exception as e:
        print("  (paquete ignorado:", e, ")", file=sys.stderr, flush=True)


# ------------------------------------------------------------------- subida ---
def push(done=False):
    if not (args.rtdb and args.secret):
        return
    with LOCK:
        kms = []
        max_km, max_pair = 0, None
        for l in links.values():
            km = hav(nodes.get(l["a"]), nodes.get(l["b"]))
            if km is None:
                continue
            l["km"] = round(km, 2)
            kms.append(km)
            if km > max_km:
                max_km, max_pair = km, l
        kms.sort()
        now = time.time()
        body = {
            f"rf/{sid}/meta": {
                "label": args.label, "root": "radio", "src": "radio-propia",
                "start": int(start * 1000), "end": int(now * 1000) if done else None,
                "updated": int(now * 1000), "polls": len(timeline), "freshMin": 0,
                "nodes": len(nodes), "links": len(links),
                "snrLinks": sum(1 for l in links.values() if l.get("snr") is not None),
                "maxKm": round(max_km, 2),
                "maxPair": ({"a": max_pair["a"], "b": max_pair["b"],
                             "an": (nodes.get(max_pair["a"]) or {}).get("name"),
                             "bn": (nodes.get(max_pair["b"]) or {}).get("name"),
                             "snr": max_pair.get("snr")} if max_pair else None),
                "medKm": round(kms[len(kms) // 2], 2) if kms else None,
                "observer": my_id, "seen": seen, "directos": directos, "indirectos": indirectos,
            },
            f"rf/{sid}/tl": timeline[-400:],
        }
        for k, l in links.items():
            body[f"rf/{sid}/links/{k}"] = l
        for nid, n in nodes.items():
            body[f"rf/{sid}/nodes/{nid}"] = n
    try:
        req = urllib.request.Request(
            f"{args.rtdb.rstrip('/')}/.json?auth={args.secret}",
            data=json.dumps(body).encode("utf-8"), method="PATCH",
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=25).read()
        return True
    except Exception as e:
        print("  (no se pudo subir:", e, ")", file=sys.stderr, flush=True)
        return False


def uploader():
    while True:
        time.sleep(args.every)
        with LOCK:
            timeline.append({"t": int(time.time() * 1000), "nodes": len(nodes),
                             "links": len(links), "snr": sum(1 for l in links.values() if l.get("snr") is not None)})
        snapshot_nodedb(IFACE)
        ok = push()
        with LOCK:
            print(f"  · {seen} paquetes ({directos} directos, {indirectos} rebotados) · "
                  f"{len(links)} enlaces medidos{'' if ok is None else ' · subido' if ok else ' · SIN SUBIR'}", flush=True)


# -------------------------------------------------------------------- main ---
pub.subscribe(on_receive, "meshtastic.receive")

if args.host:
    import meshtastic.tcp_interface
    print(f"conectando a {args.host}:4403 …", flush=True)
    IFACE = meshtastic.tcp_interface.TCPInterface(hostname=args.host)
else:
    import meshtastic.serial_interface
    print(f"conectando por serie {args.port or '(autodetectar)'} …", flush=True)
    IFACE = (meshtastic.serial_interface.SerialInterface(devPath=args.port) if args.port
             else meshtastic.serial_interface.SerialInterface())

try:
    mi = IFACE.getMyNodeInfo() or {}
    my_id = str(mi.get("num"))
    touch_node(my_id, (mi.get("user") or {}).get("longName") or "mi nodo")
    print(f"mi nodo: {my_id} ({(mi.get('user') or {}).get('longName') or '?'})", flush=True)
except Exception as e:
    print("no pude leer mi propio nodo:", e, file=sys.stderr, flush=True)

snapshot_nodedb(IFACE)
if args.rtdb and args.secret:
    print(f"subiendo a {args.rtdb.rstrip('/')}/rf/{sid} cada {args.every}s", flush=True)
    threading.Thread(target=uploader, daemon=True).start()
else:
    print("(sin --rtdb/--secret: solo se guarda el archivo local)", flush=True)
print(f"escuchando · {args.out} · Ctrl+C para cortar\n", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
finally:
    print("\ncerrando…", flush=True)
    snapshot_nodedb(IFACE)
    push(done=True)
    out.close()
    try:
        IFACE.close()
    except Exception:
        pass
    print(f"LISTO · {seen} paquetes · {directos} DIRECTOS · {len(links)} enlaces medidos por radio")
    if args.rtdb:
        print(f"       míralo en la pestaña RF: sesión {sid}")
