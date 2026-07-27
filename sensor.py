import time
import random
import json
import paho.mqtt.publish as publish

# =========================
# MQTT CONFIG
# =========================
BROKER = "localhost"
TOPIC = "sensor/emisi"

# =========================
# BAKU MUTU
# =========================
LIMIT = {
    "pm": 120,
    "co": 625,
    "so2": 210,
    "nox": 470
}

# =========================
# BASELINE AMBIENT
# Nilai latar belakang lingkungan saat tidak ada pembakaran.
# Diukur dari kondisi ambient area sekitar insinerator.
# =========================
BASELINE = {
    "pm":  0.0690,
    "co":  0.9557,
    "so2": 0.0523,
    "nox": 0.0354
}

print("Memulai Simulasi Sensor CEMS... Tekan Ctrl+C untuk berhenti.")

minute = 0

while True:
    # 0 - 20 MENIT: SEMUA AMAN
    if minute < 20:
        data = {
            "pm": random.randint(40, 100),
            "co": random.randint(100, 500),
            "so2": random.randint(50, 180),
            "nox": random.randint(150, 400)
        }
    # 20 - 40 MENIT: CO MELEBIHI
    elif minute < 40:
        data = {
            "pm": random.randint(40, 100),
            "co": random.randint(650, 800),
            "so2": random.randint(50, 180),
            "nox": random.randint(150, 400)
        }
    # 40 - 60 MENIT: SO2 MELEBIHI
    elif minute < 60:
        data = {
            "pm": random.randint(40, 100),
            "co": random.randint(100, 500),
            "so2": random.randint(220, 300),
            "nox": random.randint(150, 400)
        }
    # 60 - 80 MENIT: NOX MELEBIHI
    elif minute < 80:
        data = {
            "pm": random.randint(40, 100),
            "co": random.randint(100, 500),
            "so2": random.randint(50, 180),
            "nox": random.randint(480, 600)
        }
    # 80 - 100 MENIT: PM MELEBIHI
    elif minute < 100:
        data = {
            "pm": random.randint(125, 180),
            "co": random.randint(100, 500),
            "so2": random.randint(50, 180),
            "nox": random.randint(150, 400)
        }
    # 100 - 120 MENIT: SEMUA MELEBIHI
    elif minute < 120:
        data = {
            "pm": random.randint(130, 200),
            "co": random.randint(650, 850),
            "so2": random.randint(220, 320),
            "nox": random.randint(480, 650)
        }
    # 120 MENIT KE ATAS: TIDAK ADA PEMBAKARAN — kirim nilai baseline ambient
    else:
        data = {
            "pm":  BASELINE["pm"],
            "co":  BASELINE["co"],
            "so2": BASELINE["so2"],
            "nox": BASELINE["nox"]
        }

    try:
        publish.single(TOPIC, json.dumps(data), hostname=BROKER)
        print(f"[MENIT {minute+1}] Dikirim: {data}")
    except Exception as e:
        print(f"Gagal mengirim data MQTT: {e}")

    minute += 1
    if minute >= 130:  # Reset loop simulasi kembali ke awal
        minute = 0

    time.sleep(60)  # Interval pengiriman data real-time