#!/usr/bin/env python3
"""
rflisten — escucha por RADIO desde tu propio nodo Meshtastic y guarda cada
paquete recibido en un JSONL.

Para qué: durante un apagón de MQTT, MeshCheck se queda ciego (toda su
observación entra por ese broker). Tu nodo, en cambio, sigue oyendo el aire.
Lo que grabe este script es medición de radio de primera mano: no pasa por
internet en ningún momento, así que nadie puede confundirla con bridging.

Uso:
    pip install meshtastic pypubsub
    python rflisten.py --host 192.168.1.50          # nodo por red (WiFi)
    python rflisten.py --port COM3                  # nodo por USB
    python rflisten.py --host 192.168.1.50 --out mi-captura.jsonl

Cada línea del JSONL lleva: hora, emisor, SNR, RSSI y saltos. La clave está en
`hops`: 0 = lo oíste DIRECTO por radio, que es tu alcance real medido.
Ctrl+C cierra ordenado.
"""
import argparse, json, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--host", help="IP del nodo (interfaz TCP, puerto 4403)")
ap.add_argument("--port", help="puerto serie, p.ej. COM3 o /dev/ttyUSB0")
ap.add_argument("--out", default="rf-captura.jsonl")
args = ap.parse_args()

import meshtastic
from pubsub import pub

out = open(args.out, "a", encoding="utf-8")
seen = 0
directos = 0


def onReceive(packet, interface=None):
    global seen, directos
    try:
        dec = packet.get("decoded") or {}
        hop_start = packet.get("hopStart")
        hop_limit = packet.get("hopLimit")
        # saltos reales = los que consumió por el camino
        hops = (hop_start - hop_limit) if (isinstance(hop_start, int) and isinstance(hop_limit, int)) else None
        rec = {
            "t": round(time.time(), 3),
            "from": packet.get("fromId") or packet.get("from"),
            "to": packet.get("toId") or packet.get("to"),
            "snr": packet.get("rxSnr"),
            "rssi": packet.get("rxRssi"),
            "hops": hops,
            "hopStart": hop_start,
            "hopLimit": hop_limit,
            "type": dec.get("portnum"),
            "raw": str(packet)[:1500],
        }
        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
        out.flush()
        seen += 1
        if hops == 0:
            directos += 1
        marca = " ← DIRECTO" if hops == 0 else (f"  ({hops} saltos)" if hops else "")
        print(f"{time.strftime('%H:%M:%S')}  {rec['from']}  SNR {rec['snr']}  RSSI {rec['rssi']}  {rec['type']}{marca}", flush=True)
    except Exception as e:  # un paquete raro no debe cortar la captura
        print("  (paquete ignorado:", e, ")", file=sys.stderr, flush=True)


pub.subscribe(onReceive, "meshtastic.receive")

if args.host:
    import meshtastic.tcp_interface
    print(f"conectando a {args.host}:4403 …", flush=True)
    iface = meshtastic.tcp_interface.TCPInterface(hostname=args.host)
else:
    import meshtastic.serial_interface
    print(f"conectando por serie {args.port or '(autodetectar)'} …", flush=True)
    iface = meshtastic.serial_interface.SerialInterface(devPath=args.port) if args.port else meshtastic.serial_interface.SerialInterface()

print(f"escuchando · guardando en {args.out} · Ctrl+C para cortar\n", flush=True)
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
finally:
    out.close()
    try:
        iface.close()
    except Exception:
        pass
    print(f"\nLISTO · {seen} paquetes ({directos} oídos DIRECTO, sin repetidores) en {args.out}")
