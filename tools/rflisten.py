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
ap.add_argument("--traceroute", action="store_true",
                help="ADEMÁS de escuchar, sondea la malla con traceroute para mapear caminos multi-salto")
ap.add_argument("--tr-every", type=int, default=60, help="segundos entre traceroutes (default 60; no bajar sin razón)")
ap.add_argument("--tr-max", type=int, default=12, help="cuántos destinos sondear como máximo")
ap.add_argument("--tr-hops", type=int, default=5, help="hop limit de los traceroute")
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
seen = directos = indirectos = via_mqtt = sin_info = 0
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
    """El nodo mantiene su propia base de vecinos. De ahí salen nombres,
    posiciones y —lo más importante— `hopsAway`: cuántos saltos lo separan de
    cada nodo, contado por el propio firmware. hopsAway == 0 es un VECINO
    DIRECTO, y eso no hay que inferirlo de los paquetes: la radio ya lo sabe.
    Es más fiable que hopStart-hopLimit, que muchos paquetes ni siquiera traen.
    Nada de esto pasa por internet."""
    global directos
    try:
        db = getattr(iface, "nodes", None) or {}
    except Exception:
        return
    dir_now = 0
    for _, info in db.items():
        try:
            num = info.get("num")
            if num is None:
                continue
            nid = str(num)
            user = info.get("user") or {}
            pos = info.get("position") or {}
            lat, lon = pos.get("latitude"), pos.get("longitude")
            if lat in (0, None) or lon in (0, None):
                lat = lon = None
            n = touch_node(nid, user.get("longName") or user.get("shortName"), lat, lon, user.get("role"))
            ha = info.get("hopsAway")
            if ha is not None:
                n["hopsAway"] = ha
            if info.get("snr") is not None:
                n["snr"] = info.get("snr")
            if info.get("lastHeard"):
                n["lastHeard"] = info.get("lastHeard")
            # Vecino directo según el firmware. OJO: si el nodo tiene MQTT
            # habilitado, aprende cientos de nodos por internet y el firmware
            # les pone hopsAway = 0 (le llegaron sin saltos de radio). Por eso
            # se exige además un SNR real: sin demodulación no hubo radio.
            snr_db = info.get("snr")
            if ha == 0 and nid != my_id and snr_db not in (None, 0):
                dir_now += 1
                add_link(my_id, nid, snr_db, "rf")
        except Exception:
            continue
    if dir_now:
        directos = max(directos, dir_now)
    return dir_now


def resumen_vecinos():
    """Reparto de la base de vecinos por distancia en saltos: la foto de hasta
    dónde llega esta radio."""
    por_salto = {}
    for n in nodes.values():
        ha = n.get("hopsAway")
        if ha is None:
            continue
        por_salto[ha] = por_salto.get(ha, 0) + 1
    return por_salto


def add_link(a, b, snr, src):
    """Registra un enlace RF entre dos nodos (clave simétrica, SNR máximo)."""
    if not a or not b or a == b:
        return
    x, y = (a, b) if a < b else (b, a)
    k = f"{x}|{y}"
    prev = links.get(k)
    best = snr if prev is None or prev.get("snr") is None else (
        snr if snr is not None and snr > prev["snr"] else prev["snr"])
    links[k] = {"a": x, "b": y, "snr": best, "src": src,
                "first": prev["first"] if prev else time.time(), "last": time.time()}


def on_traceroute(packet, dec):
    """Un traceroute devuelve el camino COMPLETO con el SNR de cada salto: cada
    tramo es una medición de radio ajena que de otro modo no veríamos desde
    aquí. snr_towards[i] es la calidad con que el salto i+1 recibió del i."""
    tr = dec.get("traceroute") or {}
    if hasattr(tr, "get"):
        route = list(tr.get("route") or [])
        snrs = list(tr.get("snrTowards") or tr.get("snr_towards") or [])
        route_back = list(tr.get("routeBack") or tr.get("route_back") or [])
        snrs_back = list(tr.get("snrBack") or tr.get("snr_back") or [])
    else:  # objeto protobuf
        route = list(getattr(tr, "route", []) or [])
        snrs = list(getattr(tr, "snr_towards", []) or [])
        route_back = list(getattr(tr, "route_back", []) or [])
        snrs_back = list(getattr(tr, "snr_back", []) or [])

    def chain(seq, sn, a, b):
        ids = [str(a)] + [str(x) for x in seq] + [str(b)]
        n = 0
        for i in range(len(ids) - 1):
            s = sn[i] / 4.0 if i < len(sn) and sn[i] is not None and sn[i] != -128 else None
            # el firmware entrega dB*4; -128 = desconocido
            if s is not None and abs(s) > 40:      # ya venía en dB
                s = sn[i]
            add_link(ids[i], ids[i + 1], s, "tr")
            n += 1
        return n

    dst = str(packet.get("from"))
    hechos = chain(route, snrs, my_id, dst)
    if route_back:
        hechos += chain(route_back, snrs_back, dst, my_id)
    print(f"    ↳ traceroute: {hechos} tramos mapeados hacia {dst}", flush=True)


def on_receive(packet, interface=None):
    global seen, directos, indirectos, via_mqtt, sin_info
    try:
        dec = packet.get("decoded") or {}
        if (dec.get("portnum") == "TRACEROUTE_APP" or dec.get("traceroute")):
            with LOCK:
                try:
                    on_traceroute(packet, dec)
                except Exception as e:
                    print("  (traceroute ilegible:", e, ")", file=sys.stderr, flush=True)
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
            # El SNR es lo que separa RADIO de INTERNET: solo existe si el
            # receptor demoduló la señal. Un paquete sin SNR llegó por MQTT, y
            # si el nodo tiene MQTT habilitado, la API mezcla ambas fuentes.
            if snr is None:
                via_mqtt += 1
            # SOLO los directos prueban un enlace CON MI ANTENA: con saltos, el
            # emisor del paquete no es quien transmitió lo que oí (fue algún
            # repetidor que el protocolo no identifica), así que afirmar ese
            # enlace sería inventarlo.
            elif hops == 0 and src_id and my_id and src_id != my_id:
                directos += 1
                add_link(my_id, src_id, snr, "rf")
            elif hops:
                indirectos += 1
            else:
                sin_info += 1

        if snr is None:
            marca = "  ← por INTERNET (sin SNR: no lo oyó la antena)"
        elif hops == 0:
            marca = " ← DIRECTO por radio"
        elif hops:
            marca = f"  ({hops} saltos por radio)"
        else:
            marca = "  (radio, saltos no informados)"
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


def tracer():
    """Sondea la malla con traceroute, MUY espaciado. Cada traceroute ocupa
    tiempo de aire de todos, así que se prioriza infraestructura (routers) y se
    limita el número de destinos: mapear no debe degradar la malla."""
    time.sleep(15)                      # deja que se pueble la base de vecinos
    hechos = set()
    while True:
        try:
            with LOCK:
                cands = [nid for nid, n in nodes.items()
                         if nid != my_id and nid not in hechos and n.get("lat") is not None]
                # primero la infraestructura: es la que define la topología
                cands.sort(key=lambda nid: (0 if str(nodes[nid].get("role") or "").upper().startswith("ROUTER") else 1,
                                            nodes[nid].get("name") or nid))
            if not cands or len(hechos) >= args.tr_max:
                time.sleep(args.tr_every)
                continue
            dst = cands[0]
            hechos.add(dst)
            nm = (nodes.get(dst) or {}).get("name") or dst
            print(f"  → traceroute {len(hechos)}/{args.tr_max} hacia {nm} …", flush=True)
            try:
                IFACE.sendTraceRoute(int(dst), args.tr_hops)
            except Exception as e:
                print("    (no se pudo enviar:", e, ")", file=sys.stderr, flush=True)
        except Exception as e:
            print("  (tracer:", e, ")", file=sys.stderr, flush=True)
        time.sleep(args.tr_every)


def uploader():
    while True:
        time.sleep(args.every)
        with LOCK:
            timeline.append({"t": int(time.time() * 1000), "nodes": len(nodes),
                             "links": len(links), "snr": sum(1 for l in links.values() if l.get("snr") is not None)})
        with LOCK:
            snapshot_nodedb(IFACE)
            rep = resumen_vecinos()
            reparto = " ".join(f"{k}s:{v}" for k, v in sorted(rep.items())) or "sin datos"
            ok_txt = ""
        ok = push()
        with LOCK:
            ok_txt = "" if ok is None else (" · subido" if ok else " · SIN SUBIR")
            print(f"  · {seen} paquetes · vecinos por saltos [{reparto}] · "
                  f"{len(links)} enlaces medidos{ok_txt}", flush=True)


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
if args.traceroute:
    print(f"traceroute ACTIVO: hasta {args.tr_max} destinos, uno cada {args.tr_every}s "
          f"(ocupa tiempo de aire de toda la malla — no lo dejes corriendo de más)", flush=True)
    threading.Thread(target=tracer, daemon=True).start()
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
    porRadio = seen - via_mqtt
    print(f"\nLISTO · {seen} paquetes recibidos por la API")
    print(f"       {porRadio} por RADIO (con SNR) · {via_mqtt} por INTERNET (sin SNR, vía MQTT del nodo)")
    print(f"       {directos} directos · {indirectos} repetidos · {sin_info} sin dato de saltos")
    print(f"       {len(links)} enlaces medidos por radio · {len(nodes)} nodos conocidos")
    if via_mqtt:
        print(f"\n       OJO: tu nodo tiene MQTT habilitado, así que la API mezcla radio e internet.")
        print(f"       Solo los {porRadio} con SNR son medición de radio. Para una prueba RF")
        print(f"       limpia, desactiva el MQTT del nodo durante el ensayo.")
    if args.rtdb:
        print(f"       míralo en la pestaña RF: sesión {sid}")
