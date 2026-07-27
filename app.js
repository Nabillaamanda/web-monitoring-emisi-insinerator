const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const mqtt = require("mqtt");
const mysql = require("mysql2");
let PDFDocument;
try {
  PDFDocument = require("pdfkit");
} catch (err) {
  console.warn("Warning: 'pdfkit' not installed. Report PDF generation will be disabled.");
  PDFDocument = null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 5000;

// ======================
// MYSQL
// ======================

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "Amandoo24#",
  database: "emisi_db"
});

db.connect(err => {
  if (err) {
    console.log(err);
  } else {
    console.log("MYSQL CONNECTED");
  }
});

// ======================
// BAKU MUTU (PermenLHK No. 70/2016)
// ======================

const LIMIT = {
  pm: 120,
  co: 625,
  so2: 210,
  nox: 470
};

// Berapa lama tanpa data baru sebelum dianggap "tidak ada pembakaran"
const IDLE_MS = 90 * 1000; // 90 detik (1.5 menit) — buffer aman di atas interval kirim sensor (60 detik)

// Nilai baseline ambient lingkungan (bukan 0) — dikirim sensor saat tidak ada pembakaran
const BASELINE = { pm: 0.0690, co: 0.9557, so2: 0.0523, nox: 0.0354 };
// Threshold deteksi: kalau semua nilai di bawah ini, dianggap tidak ada pembakaran
const NO_COMBUSTION_THRESHOLD = { pm: 1.0, co: 2.0, so2: 1.0, nox: 1.0 };

// Simpan data terakhir di memori supaya client baru connect langsung dapat
// data tanpa harus menunggu MQTT message berikutnya.
let lastReading = null; // { pm, co, so2, nox, created_at }

// ======================
// STATUS HELPERS
// ======================

function getStatus(value, limit) {
  const percent = Math.round((value / limit) * 100);
  return {
    percent,
    status:
      percent <= 75 ? "safe" :
      percent <= 100 ? "warn" :
      "danger"
  };
}

function buildGases(row) {
  return {
    pm:  { value: row.pm,  ...getStatus(row.pm,  LIMIT.pm) },
    co:  { value: row.co,  ...getStatus(row.co,  LIMIT.co) },
    so2: { value: row.so2, ...getStatus(row.so2, LIMIT.so2) },
    nox: { value: row.nox, ...getStatus(row.nox, LIMIT.nox) }
  };
}

// Apakah data ini menunjukkan tidak ada pembakaran?
// Cek apakah semua nilai di bawah threshold (baseline ambient), bukan cuma == 0
function isNoCombustion(row) {
  return row.pm  < NO_COMBUSTION_THRESHOLD.pm  &&
         row.co  < NO_COMBUSTION_THRESHOLD.co  &&
         row.so2 < NO_COMBUSTION_THRESHOLD.so2 &&
         row.nox < NO_COMBUSTION_THRESHOLD.nox;
}

// Status keseluruhan: cek semua gas, sebutkan nama gas spesifik yang
// melebihi/mendekati baku mutu (bukan cuma "salah satu melebihi").
function getOverallStatus(gases) {
  const NAMES = { pm: "Total Partikulat", co: "CO", so2: "SO\u2082", nox: "NO\u2093" };

  const danger = Object.keys(gases).filter(k => gases[k].status === "danger");
  const warn   = Object.keys(gases).filter(k => gases[k].status === "warn");

  if (danger.length > 0) {
    return {
      color: "danger",
      text: `Melebihi Batas Baku Mutu: ${danger.map(k => NAMES[k]).join(", ")}`,
      exceeded: danger,
      approaching: warn
    };
  }

  if (warn.length > 0) {
    return {
      color: "warn",
      text: `Mendekati Batas Baku Mutu: ${warn.map(k => NAMES[k]).join(", ")}`,
      exceeded: [],
      approaching: warn
    };
  }

  return {
    color: "safe",
    text: "Semua Parameter Dalam Batas Aman",
    exceeded: [],
    approaching: []
  };
}

function buildPayload(row) {
  if (isNoCombustion(row)) {
    return {
      noCombustion: true,
      date: new Date(row.created_at).toLocaleDateString("id-ID"),
      time: new Date(row.created_at).toLocaleTimeString("id-ID"),
      created_at: row.created_at
    };
  }

  const gases = buildGases(row);

  return {
    noCombustion: false,
    date: new Date(row.created_at).toLocaleDateString("id-ID"),
    time: new Date(row.created_at).toLocaleTimeString("id-ID"),
    created_at: row.created_at,
    gases,
    overall: getOverallStatus(gases)
  };
}

// ======================
// MIDDLEWARE
// ======================

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======================
// ROUTES — HALAMAN (semua publik, tidak ada login)
// ======================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views/index.html"));
});

app.get("/report", (req, res) => {
  res.sendFile(path.join(__dirname, "views/report.html"));
});

app.get("/about", (req, res) => {
  res.sendFile(path.join(__dirname, "views/about.html"));
});

app.get("/contact", (req, res) => {
  res.sendFile(path.join(__dirname, "views/contact.html"));
});

// ======================
// MQTT  ->  MySQL  ->  Socket.IO (full real-time pipeline)
// sensor.py mempublikasikan data lewat MQTT; server subscribe topik
// itu, menyimpan ke MySQL, lalu broadcast ke semua dashboard yang
// terbuka lewat Socket.IO (tanpa perlu polling HTTP dari browser).
// ======================

const mqttClient = mqtt.connect("mqtt://localhost:1883");

mqttClient.on("connect", () => {
  console.log("MQTT CONNECTED");
  mqttClient.subscribe("sensor/emisi");
});

mqttClient.on("message", (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    const row = {
      pm:  data.pm  || 0,
      co:  data.co  || 0,
      so2: data.so2 || 0,
      nox: data.nox || 0,
      created_at: new Date()
    };

    db.query(
      `INSERT INTO emisi (pm, co, so2, nox) VALUES (?, ?, ?, ?)`,
      [row.pm, row.co, row.so2, row.nox]
    );

    onNewData(row); // update lastReading + reset idleWritten flag

    io.emit("emisi-update", buildPayload(row));

  } catch (err) {
    console.log(err);
  }
});

// Cek idle setiap 30 detik: kalau data terakhir sudah lebih dari
// IDLE_MS menit tanpa data baru, tulis baris baseline ke DB sebagai
// pemisah siklus DAN broadcast ke client. Setelah itu reset lastReading
// supaya tidak terus-menerus nulis baris baseline setiap 30 detik.
let idleWritten = false; // flag supaya hanya tulis 1 baris per periode mati

setInterval(() => {
  if (!lastReading) return;
  const age = Date.now() - new Date(lastReading.created_at).getTime();
  if (age > IDLE_MS && !idleWritten) {
    // Tulis baris baseline ke DB sebagai penanda siklus berakhir
    db.query(
      `INSERT INTO emisi (pm, co, so2, nox) VALUES (?, ?, ?, ?)`,
      [BASELINE.pm, BASELINE.co, BASELINE.so2, BASELINE.nox],
      (err) => {
        if (!err) console.log('[IDLE] Baris baseline ditulis ke DB sebagai pemisah siklus.');
      }
    );
    idleWritten = true;
    lastReading = null; // reset supaya /data tidak return data lama
    io.emit("emisi-update", { noCombustion: true, idle: true });
  }
}, 30000);

// Reset flag idleWritten saat data baru masuk (sensor nyala lagi)
// supaya siklus berikutnya bisa nulis pemisah lagi kalau mati lagi.
function onNewData(row) {
  if (idleWritten) {
    idleWritten = false;
    console.log('[MQTT] Data baru masuk, siklus baru dimulai.');
  }
  lastReading = row;
}

// ======================
// DATA TERBARU — fallback HTTP, dipakai saat halaman baru dimuat
// sebelum Socket.IO sempat mengirim event pertama.
// ======================

app.get("/data", (req, res) => {
  if (!lastReading) return res.json({});

  const age = Date.now() - new Date(lastReading.created_at).getTime();
  if (age > IDLE_MS) {
    return res.json({ noCombustion: true });
  }

  res.json(buildPayload(lastReading));
});

// ======================
// CHART HISTORY — histori titik untuk mengisi grafik tren saat
// halaman/device BARU dibuka, supaya chart tidak kosong/cuma 1 titik.
// Diambil dari MySQL (permanen), bukan dari sessionStorage browser,
// supaya semua device (HP, laptop, tablet) melihat histori yang sama
// sejak data mulai masuk — bukan cuma sejak device itu sendiri dibuka.
//
// PENTING: histori ini HANYA mengambil data sejak siklus pembakaran
// AKTIF/TERAKHIR dimulai (berhenti di baris "tidak ada pembakaran"
// paling baru). Tanpa batas ini, grafik akan "menyambung" data dari
// sebelum sensor dimatikan dengan data setelah sensor dinyalakan lagi,
// padahal seharusnya dianggap siklus/sesi yang berbeda.
// ======================

app.get("/chart-history", (req, res) => {
  const points = Math.min(parseInt(req.query.points) || 60, 300);
  // Parameter date opsional — kalau ada, batasi hanya ke hari itu.
  // Dashboard selalu kirim date=today supaya tidak dapat data kemarin
  // kalau sensor mati tanpa menulis baris noCombustion ke DB.
  const dateFilter = req.query.date || null;

  // 1) Cari id baris noCombustion PALING BARU — data setelah id ini
  //    yang dianggap siklus aktif. Kalau ada dateFilter, cari hanya
  //    di hari itu supaya batas siklus tidak lintas hari.
  const idleSQL = dateFilter
    ? `SELECT id FROM emisi WHERE pm < 1.0 AND co < 2.0 AND so2 < 1.0 AND nox < 1.0 AND DATE(created_at) = ? ORDER BY id DESC LIMIT 1`
    : `SELECT id FROM emisi WHERE pm < 1.0 AND co < 2.0 AND so2 < 1.0 AND nox < 1.0 ORDER BY id DESC LIMIT 1`;
  const idleParams = dateFilter ? [dateFilter] : [];

  db.query(idleSQL, idleParams, (err, idleRows) => {
    if (err) return res.json({ labels: [], pm: [], co: [], so2: [], nox: [] });

    const sinceId = idleRows.length > 0 ? idleRows[0].id : 0;

    // 2) Ambil data setelah sinceId, dengan filter tanggal kalau ada
    const dataSQL = dateFilter
      ? `SELECT * FROM (SELECT * FROM emisi WHERE id > ? AND DATE(created_at) = ? ORDER BY id DESC LIMIT ?) t ORDER BY id ASC`
      : `SELECT * FROM (SELECT * FROM emisi WHERE id > ? ORDER BY id DESC LIMIT ?) t ORDER BY id ASC`;
    const dataParams = dateFilter ? [sinceId, dateFilter, points] : [sinceId, points];

    db.query(dataSQL, dataParams, (err2, rows) => {
      if (err2) return res.json({ labels: [], pm: [], co: [], so2: [], nox: [] });

      const labels = [];
      const pm = []; const co = []; const so2 = []; const nox = [];

      rows.forEach(r => {
        labels.push(new Date(r.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }));
        pm.push(r.pm);
        co.push(r.co);
        so2.push(r.so2);
        nox.push(r.nox);
      });

      res.json({ labels, pm, co, so2, nox });
    });
  });
});

// ======================
// COMBUSTION CYCLES — deteksi siklus pembakaran dalam satu tanggal.
// Satu "siklus" adalah rangkaian baris berurutan yang BUKAN semua-nol
// (ada aktivitas pembakaran), dipisahkan oleh satu atau lebih baris
// "tidak ada pembakaran" (semua gas = 0). Dalam satu hari bisa ada
// lebih dari satu siklus, sesuai gap idle yang terekam sensor.
// ======================

function detectCycles(rows) {
  const cycles = [];
  let current = null;

  rows.forEach(r => {
    const isZero = isNoCombustion(r);

    if (isZero) {
      if (current) { cycles.push(current); current = null; }
      return;
    }

    if (!current) current = { rows: [] };
    current.rows.push(r);
  });

  if (current) cycles.push(current);
  return cycles;
}

app.get("/combustion-cycles", (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  db.query(
    `SELECT * FROM emisi WHERE DATE(created_at) = ? ORDER BY id ASC`,
    [date],
    (err, rows) => {
      if (err) return res.json({ cycles: [] });

      const cycles = detectCycles(rows);

      const summary = cycles.map((c, i) => {
        const first = c.rows[0];
        const last = c.rows[c.rows.length - 1];
        return {
          index: i,
          startTime: new Date(first.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
          endTime: new Date(last.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
          points: c.rows.length
        };
      });

      res.json({ cycles: summary });
    }
  );
});

// ======================
// CYCLE DATA — data titik-titik (untuk chart) pada satu siklus
// pembakaran tertentu, di tanggal tertentu.
// ======================

app.get("/cycle-data", (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const cycleIndex = parseInt(req.query.cycle) || 0;

  db.query(
    `SELECT * FROM emisi WHERE DATE(created_at) = ? ORDER BY id ASC`,
    [date],
    (err, rows) => {
      if (err) return res.json({ labels: [], pm: [], co: [], so2: [], nox: [] });

      const cycles = detectCycles(rows);
      const cycle = cycles[cycleIndex];

      if (!cycle) return res.json({ labels: [], pm: [], co: [], so2: [], nox: [] });

      const labels = []; const pm = []; const co = []; const so2 = []; const nox = [];

      cycle.rows.forEach(r => {
        labels.push(new Date(r.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }));
        pm.push(r.pm);
        co.push(r.co);
        so2.push(r.so2);
        nox.push(r.nox);
      });

      res.json({ labels, pm, co, so2, nox });
    }
  );
});

// ======================
// EXCEEDANCE COUNT — akumulasi berapa kali tiap parameter melebihi
// baku mutu, dihitung SEJAK siklus pembakaran aktif saat ini dimulai.
// Siklus baru dianggap mulai begitu ditemukan baris "tidak ada
// pembakaran" (semua gas = 0) — akumulasi reset ke 0 setelah itu.
// ======================

app.get("/exceedance-count", (req, res) => {
  // 1) Cari id baris noCombustion (semua 0) PALING BARU.
  db.query(
    `SELECT id FROM emisi WHERE pm < 1.0 AND co < 2.0 AND so2 < 1.0 AND nox < 1.0 ORDER BY id DESC LIMIT 1`,
    (err, idleRows) => {
      if (err) return res.json({ pm: 0, co: 0, so2: 0, nox: 0 });

      const sinceId = idleRows.length > 0 ? idleRows[0].id : 0;

      // 2) Hitung berapa kali tiap parameter melebihi baku mutu pada
      // baris-baris SETELAH id tersebut (siklus pembakaran saat ini).
      db.query(
        `SELECT
           SUM(CASE WHEN pm  > ? THEN 1 ELSE 0 END) AS pm_count,
           SUM(CASE WHEN co  > ? THEN 1 ELSE 0 END) AS co_count,
           SUM(CASE WHEN so2 > ? THEN 1 ELSE 0 END) AS so2_count,
           SUM(CASE WHEN nox > ? THEN 1 ELSE 0 END) AS nox_count
         FROM emisi WHERE id > ?`,
        [LIMIT.pm, LIMIT.co, LIMIT.so2, LIMIT.nox, sinceId],
        (err2, rows) => {
          if (err2 || rows.length === 0) return res.json({ pm: 0, co: 0, so2: 0, nox: 0 });

          const r = rows[0];
          res.json({
            pm:  r.pm_count  || 0,
            co:  r.co_count  || 0,
            so2: r.so2_count || 0,
            nox: r.nox_count || 0
          });
        }
      );
    }
  );
});

// ======================
// HISTORY (tabel)
// ======================

app.get("/history", (req, res) => {
  const q = (req.query.q || '').trim();

  // Kalau ada query search, cari ke seluruh DB berdasarkan tanggal/jam/nilai.
  // Kalau tidak ada, return 300 baris terbaru untuk tampilan default tabel.
  let sql, values;
  if (q) {
    // Cari berdasarkan tanggal (DATE_FORMAT) atau nilai parameter.
    // Gunakan LIKE di sisi server untuk cari tanggal format ID (d/m/Y).
    sql = `
      SELECT * FROM emisi
      WHERE DATE_FORMAT(created_at, '%d/%m/%Y') LIKE ?
         OR DATE_FORMAT(created_at, '%H:%i') LIKE ?
         OR CAST(pm  AS CHAR) LIKE ?
         OR CAST(co  AS CHAR) LIKE ?
         OR CAST(so2 AS CHAR) LIKE ?
         OR CAST(nox AS CHAR) LIKE ?
      ORDER BY id DESC LIMIT 500`;
    const like = `%${q}%`;
    values = [like, like, like, like, like, like];
  } else {
    sql = `SELECT * FROM emisi ORDER BY id DESC LIMIT 300`;
    values = [];
  }

  db.query(sql, values, (err, rows) => {
    if (err) return res.json([]);

    const data = rows.map(r => {
      const exceeded = [];
      if (r.pm  > LIMIT.pm)  exceeded.push("PM");
      if (r.co  > LIMIT.co)  exceeded.push("CO");
      if (r.so2 > LIMIT.so2) exceeded.push("SO\u2082");
      if (r.nox > LIMIT.nox) exceeded.push("NO\u2093");

      return {
        date: new Date(r.created_at).toLocaleDateString("id-ID"),
        time: new Date(r.created_at).toLocaleTimeString("id-ID"),
        pm: r.pm, co: r.co, so2: r.so2, nox: r.nox,
        exceeded
      };
    });

    res.json(data);
  });
});

// ======================
// REPORT DOWNLOAD
// ======================

// Helper: tentukan status teks untuk satu baris data
function rowStatus(r, safeParams) {
  if (isNoCombustion(r)) return "Tidak Ada Pembakaran";
  const exceeded = [];
  const PARAM_NAMES = { pm: "PM", co: "CO", so2: "SO2", nox: "NOx" };
  safeParams.forEach(p => { if (r[p] > LIMIT[p]) exceeded.push(PARAM_NAMES[p]); });
  return exceeded.length > 0 ? `${exceeded.join(", ")} melebihi baku mutu` : "Normal";
}

// Helper: gambar grafik sederhana pakai pdfkit native drawing (tidak butuh library tambahan)
// dataArr = array angka, limit = baku mutu, title = judul, doc = PDFDocument instance
function drawChart(doc, dataArr, limit, baseline, title, paramColor) {
  const W = 490, H = 100;
  const x0 = 40, y0 = doc.y + 8;

  doc.fontSize(9).fillColor("#333333").text(title, x0, y0, { width: W });
  const chartY = y0 + 14;

  doc.rect(x0, chartY, W, H).fillColor("#f8f8f8").fill();
  doc.rect(x0, chartY, W, H).strokeColor("#dddddd").lineWidth(0.5).stroke();

  if (dataArr.length < 2) {
    doc.fontSize(8).fillColor("#999999").text("(tidak cukup data)", x0 + W / 2 - 30, chartY + H / 2 - 5);
    doc.y = chartY + H + 12;
    return;
  }

  const maxVal = Math.max(...dataArr, limit) * 1.15;
  const toY = v => chartY + H - (v / maxVal) * H;
  const toX = i => x0 + (i / (dataArr.length - 1)) * W;

  // Garis baseline ambient (hijau tosca, putus-putus)
  if (baseline > 0) {
    const baselineY = toY(baseline);
    doc.moveTo(x0, baselineY).lineTo(x0 + W, baselineY)
       .strokeColor("#0d9488").lineWidth(0.7).dash(3, { space: 4 }).stroke().undash();
    doc.fontSize(7).fillColor("#0d9488").text(`Baseline: ${baseline}`, x0 + 2, baselineY - 8, { width: 60 });
  }

  // Garis baku mutu (merah putus-putus)
  const limitY = toY(limit);
  doc.moveTo(x0, limitY).lineTo(x0 + W, limitY)
     .strokeColor("#e05050").lineWidth(0.6).dash(4, { space: 3 }).stroke().undash();
  doc.fontSize(7).fillColor("#e05050").text(`BM: ${limit}`, x0 + W - 35, limitY - 8);

  // Garis data
  doc.moveTo(toX(0), toY(dataArr[0]));
  for (let i = 1; i < dataArr.length; i++) doc.lineTo(toX(i), toY(dataArr[i]));
  doc.strokeColor(paramColor).lineWidth(1.2).stroke();

  // Label sumbu Y
  doc.fontSize(7).fillColor("#888888");
  doc.text("0",                    x0 - 18, chartY + H - 6,  { width: 16, align: "right" });
  doc.text(Math.round(maxVal / 2), x0 - 18, chartY + H / 2 - 4, { width: 16, align: "right" });
  doc.text(Math.round(maxVal),     x0 - 18, chartY - 4,         { width: 16, align: "right" });

  doc.y = chartY + H + 14;
}

app.get("/report/download", (req, res) => {
  const { type, format, params, bulan, tahun, from, to } = req.query;

  const selectedParams = params ? params.split(",") : ["pm", "co", "so2", "nox"];
  const allowedParams = ["pm", "co", "so2", "nox"];
  const safeParams = selectedParams.filter(p => allowedParams.includes(p));

  let sql = `SELECT * FROM emisi`;
  const values = [];

  if (type === "rentang" && from && to) {
    sql += ` WHERE DATE(created_at) BETWEEN ? AND ?`;
    values.push(from, to);
  } else if (bulan && tahun) {
    sql += ` WHERE MONTH(created_at) = ? AND YEAR(created_at) = ?`;
    values.push(bulan, tahun);
  }

  sql += ` ORDER BY id ASC`;

  // Nama file: sertakan parameter yang dipilih (kalau bukan semua)
  const BULAN_NAMA = [
    "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
  ];
  const PARAM_NAMES = { pm: "PM", co: "CO", so2: "SO2", nox: "NOx" };

  const allParams = safeParams.length === 4;
  const paramSuffix = allParams ? "" : `_${safeParams.map(p => PARAM_NAMES[p]).join("-")}`;

  let baseFilename = "laporan-emisi";
  if (type === "rentang" && from && to) {
    baseFilename = (from === to)
      ? `laporan-emisi_${from}${paramSuffix}`
      : `laporan-emisi_${from}_sd_${to}${paramSuffix}`;
  } else if (bulan && tahun) {
    const namaBulan = BULAN_NAMA[parseInt(bulan)] || bulan;
    baseFilename = `laporan-emisi_${namaBulan}-${tahun}${paramSuffix}`;
  }

  db.query(sql, values, (err, rows) => {
    if (err) return res.send("Database Error");

    // ── CSV ──────────────────────────────────────────────────────────────
    if (format === "csv") {
      const paramHeaders = safeParams.map(p => `${PARAM_NAMES[p]} (mg/Nm3)`).join(",");
      let csv = `Tanggal,Jam,${paramHeaders},Status\n`;

      rows.forEach(r => {
        const tanggal = new Date(r.created_at).toLocaleDateString("id-ID");
        const jam     = new Date(r.created_at).toLocaleTimeString("id-ID");
        const vals    = safeParams.map(p => r[p] ?? "").join(",");
        const status  = rowStatus(r, safeParams);
        csv += `${tanggal},${jam},${vals},"${status}"\n`;
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}.csv"`);
      return res.send(csv);
    }

    // ── PDF ──────────────────────────────────────────────────────────────
    if (!PDFDocument) {
      return res.status(500).send("PDF generation tidak tersedia. Install pdfkit: npm install pdfkit");
    }

    const isHarian = type === "rentang";
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}.pdf"`);
    doc.pipe(res);

    // ── Header ──
    doc.fontSize(16).fillColor("#111111").text("Laporan Monitoring Emisi Insinerator", { align: "center" });
    doc.fontSize(10).fillColor("#555555").text("CEMS — Continuous Emission Monitoring System", { align: "center" });
    doc.moveDown(0.5);

    const periodeText = isHarian
      ? (from === to ? from : `${from} s/d ${to}`)
      : `${BULAN_NAMA[parseInt(bulan)] || bulan} ${tahun}`;

    doc.fontSize(10).fillColor("#333333")
       .text(`Jenis Laporan : ${isHarian ? "Harian" : "Bulanan"}`, 40)
       .text(`Periode       : ${periodeText}`)
       .text(`Parameter     : ${allParams ? "Semua Parameter" : safeParams.map(p => PARAM_NAMES[p]).join(", ")}`);
    doc.moveDown(1);

    // ── Grafik siklus pembakaran (khusus laporan harian) ──
    if (isHarian) {
      const cycles = detectCycles(rows);
      const CHART_COLORS = { pm: "#3b82f6", co: "#14b8a6", so2: "#ca8a04", nox: "#e879a0" };

      if (cycles.length === 0) {
        doc.fontSize(10).fillColor("#888888").text("Tidak ada data pembakaran pada periode ini.", { align: "center" });
        doc.moveDown(1);
      } else {
        cycles.forEach((cycle, ci) => {
          const first = cycle.rows[0];
          const last  = cycle.rows[cycle.rows.length - 1];
          const tStart = new Date(first.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
          const tEnd   = new Date(last.created_at).toLocaleTimeString("id-ID",  { hour: "2-digit", minute: "2-digit" });

          doc.fontSize(11).fillColor("#111111")
             .text(`Pembakaran ${ci + 1} (${tStart} – ${tEnd})`, 40, doc.y, { underline: true });
          doc.moveDown(0.3);

          safeParams.forEach(p => {
            if (doc.y > 680) doc.addPage();
            const dataArr = cycle.rows.map(r => Number(r[p]) || 0);
            drawChart(doc, dataArr, LIMIT[p], BASELINE[p], `${PARAM_NAMES[p]} (Baku Mutu: ${LIMIT[p]} mg/Nm³)`, CHART_COLORS[p]);
          });

          doc.moveDown(0.8);
          if (ci < cycles.length - 1) {
            doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor("#cccccc").lineWidth(0.5).stroke();
            doc.moveDown(0.5);
          }
        });
      }

      if (doc.y > 600) doc.addPage();
      doc.moveDown(0.5);
    }

    // ── Tabel data ──
    const COL = { no: 40, tgl: 68, jam: 145, paramStart: 218, status: null };
    const paramColW = safeParams.length <= 2 ? 80 : safeParams.length === 3 ? 70 : 62;
    COL.status = COL.paramStart + safeParams.length * paramColW;
    const statusColW = 555 - COL.status;

    // Header tabel
    const drawTableHeader = (y) => {
      doc.rect(40, y, 515, 16).fillColor("#e8e8e8").fill();
      doc.fontSize(8).fillColor("#111111");
      doc.text("No",      COL.no,     y + 4, { width: 24 });
      doc.text("Tanggal", COL.tgl,    y + 4, { width: 74 });
      doc.text("Jam",     COL.jam,    y + 4, { width: 70 });
      safeParams.forEach((p, i) => {
        doc.text(`${PARAM_NAMES[p]}\n(mg/Nm³)`, COL.paramStart + i * paramColW, y + 1, { width: paramColW - 4, align: "center" });
      });
      doc.text("Status", COL.status, y + 4, { width: statusColW });
      return y + 18;
    };

    doc.fontSize(12).fillColor("#111111").text("Tabel Data Emisi", 40, doc.y);
    doc.moveDown(0.4);

    let y = drawTableHeader(doc.y);

    rows.forEach((r, i) => {
      if (y > 760) {
        doc.addPage();
        y = drawTableHeader(50);
      }

      // Zebra stripe
      if (i % 2 === 1) doc.rect(40, y, 515, 16).fillColor("#fafafa").fill();

      const createdAt = r.created_at ? new Date(r.created_at) : new Date();
      const status    = rowStatus(r, safeParams);

      // Warna baris kalau ada pelanggaran
      const isExceeded = safeParams.some(p => r[p] > LIMIT[p]);
      const isNoCombus = isNoCombustion(r);
      const textColor  = isExceeded ? "#c0392b" : isNoCombus ? "#888888" : "#111111";

      doc.fontSize(8).fillColor(textColor);
      doc.text(i + 1,                                           COL.no,     y + 4, { width: 24 });
      doc.text(createdAt.toLocaleDateString("id-ID"),           COL.tgl,    y + 4, { width: 74 });
      doc.text(createdAt.toLocaleTimeString("id-ID"),           COL.jam,    y + 4, { width: 70 });
      safeParams.forEach((p, idx) => {
        const val = (r[p] === null || r[p] === undefined) ? "-" : String(r[p]);
        doc.text(val, COL.paramStart + idx * paramColW, y + 4, { width: paramColW - 4, align: "center" });
      });
      doc.text(status, COL.status, y + 4, { width: statusColW });

      // Garis bawah baris
      doc.moveTo(40, y + 16).lineTo(555, y + 16).strokeColor("#eeeeee").lineWidth(0.3).stroke();

      y += 16;
    });

    doc.end();
  });
});

// ======================
// SOCKET.IO — kirim data terakhir begitu client connect, ditandai
// initial:true supaya client tidak menganggapnya sebagai titik baru
// (mencegah duplikasi titik chart saat pindah halaman lalu balik lagi).
// ======================

io.on("connection", (socket) => {
  if (lastReading) {
    const age = Date.now() - new Date(lastReading.created_at).getTime();
    if (age > IDLE_MS) {
      socket.emit("emisi-update", { noCombustion: true, initial: true });
    } else {
      socket.emit("emisi-update", { ...buildPayload(lastReading), initial: true });
    }
  }
});

// ======================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`http://localhost:${PORT}`);
});