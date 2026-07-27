// ============================================================
// BAKU MUTU (PermenLHK No. 70/2016)
// ============================================================
const LIMIT    = { pm: 120, co: 625, so2: 210, nox: 470 };
const BASELINE = { pm: 0.069, co: 0.9557, so2: 0.0523, nox: 0.0354 };

// Berat molekul (g/mol) untuk konversi mg/Nm3 -> ppm.
// Rumus: ppm = mg/Nm3 * 24.45 / BM (kondisi standar 25 C, 1 atm).
// PM (partikulat) TIDAK dikonversi — ppm adalah satuan berbasis volume
// gas, sementara PM adalah padatan, bukan gas.
const MOLAR_WEIGHT = { co: 28, so2: 64, nox: 46 };
const MOLAR_VOLUME = 24.45;

function mgNm3ToPpm(value, gasKey) {
  const bm = MOLAR_WEIGHT[gasKey];
  if (!bm) return null; // PM tidak punya konversi ppm
  return (value * MOLAR_VOLUME / bm).toFixed(2);
}

const NAMES = {
  pm:  "Total Partikulat (PM)",
  co:  "CO",
  so2: "SO\u2082",
  nox: "NO\u2093"
};

// Warna garis chart — netral, bukan merah/kuning/hijau (warna status
// tetap merah/kuning/hijau, tapi khusus garis di canvas pakai palet ini)
const GAS_COLOR = {
  pm:  { line: 'oklch(48% 0.18 240)',              bg: 'oklch(48% 0.18 240 / 0.06)' },
  nox: { line: 'oklch(57.961% 0.22364 343.904)',   bg: 'oklch(57.961% 0.22364 343.904 / 0.06)' },
  co:  { line: 'oklch(38.123% 0.07311 173.166)',   bg: 'oklch(38.123% 0.07311 173.166 / 0.06)' },
  so2: { line: 'oklch(59.697% 0.12718 105.906)',   bg: 'oklch(59.697% 0.12718 105.906 / 0.06)' }
};

// ============================================================
// SIDEBAR TOGGLE
// ============================================================
function toggleSidebar() {
  document.getElementById('app').classList.toggle('sidebar-open');
}

// ============================================================
// CLOCK — real per menit/detik, tanggal Indonesia
// ============================================================
function updateClock() {
  const el = document.getElementById('clock');
  const dateEl = document.getElementById('dateInfo');
  if (!el && !dateEl) return;

  const now = new Date();

  if (el) {
    el.textContent = now.toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  if (dateEl) {
    const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    dateEl.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  }
}
updateClock();
setInterval(updateClock, 1000);

// ============================================================
// LUCIDE ICONS
// ============================================================
if (window.lucide) lucide.createIcons();


// ============================================================
// SESSION DATA — riwayat poin chart sejak pembakaran dimulai.
// Disimpan di sessionStorage (bukan variabel JS biasa) supaya TIDAK
// reset saat pindah halaman (Dashboard <-> Report <-> Contact).
// sessionStorage otomatis hilang hanya saat tab/browser ditutup,
// dan di-reset manual lewat resetSession() saat server bilang
// noCombustion (bukan idle broadcast).
// ============================================================
// ============================================================
// SESSION DATA — riwayat poin chart sejak pembakaran dimulai.
// Sengaja TIDAK disimpan ke sessionStorage supaya setiap kali
// halaman dibuka grafik selalu mulai dari kosong dan hanya
// menampilkan data real-time yang diterima sejak saat itu.
// Reset otomatis terjadi tiap noCombustion (sensor berhenti).
// ============================================================
let session = { labels: [], pm: [], co: [], so2: [], nox: [] };
const MAX_POINTS = 60; // tampilkan 60 titik terakhir di grafik tren

function pushPoint(gases) {
  const now = new Date();
  const label = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  session.labels.push(label);
  session.pm.push(Number(gases.pm.value));
  session.co.push(Number(gases.co.value));
  session.so2.push(Number(gases.so2.value));
  session.nox.push(Number(gases.nox.value));

  if (session.labels.length > MAX_POINTS) {
    session.labels.shift();
    session.pm.shift();
    session.co.shift();
    session.so2.shift();
    session.nox.shift();
  }
}

function resetSession() {
  session = { labels: [], pm: [], co: [], so2: [], nox: [] };

  // Hancurkan chart instance yang ada supaya saat siklus baru mulai,
  // grafik benar-benar kosong — bukan melanjutkan garis dari siklus lama.
  Object.keys(liveCharts).forEach(key => {
    if (liveCharts[key]) {
      liveCharts[key].destroy();
      liveCharts[key] = null;
    }
  });
}

// ============================================================
// CHART OPTIONS FACTORY
// ============================================================
function makeOpts(max) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'oklch(15% 0.012 240)',
        titleFont: { size: 10, family: 'Inter' },
        bodyFont: { size: 11, family: 'Inter', weight: '600' },
        padding: 8,
        cornerRadius: 6,
        displayColors: false
      }
    },
    scales: {
      x: {
        type: 'category',
        grid: { display: false },
        ticks: { font: { size: 9, family: 'Inter' }, color: 'oklch(58% 0.005 240)', maxTicksLimit: 8 },
        border: { display: false }
      },
      y: {
        min: 0,
        max: max,
        grid: { color: 'oklch(93% 0.005 240)' },
        ticks: { font: { size: 9, family: 'Inter' }, color: 'oklch(58% 0.005 240)' },
        border: { display: false }
      }
    }
  };
}

// ============================================================
// MAIN CHART (Dashboard Ringkasan) — sekarang menampilkan
// SATU garis baku mutu per parameter (4 garis limit, bukan 1)
// ============================================================
// ============================================================
// GRAFIK LIVE TAB CHARTS (per parameter, baku mutu masing-masing)
// ============================================================
let liveCharts = { pm: null, co: null, so2: null, nox: null };

// Hitung batas Y dinamis: ambil nilai tertinggi dari data aktual,
// bandingkan dengan baku mutu, lalu beri padding 20% di atas nilai tertinggi.
// Ini mencegah grafik terpotong saat data melebihi baku mutu.
function calcDynamicMax(dataArr, limitVal) {
  if (!dataArr || dataArr.length === 0) return Math.ceil(limitVal * 1.2);
  const dataMax = Math.max(...dataArr);
  // Ambil nilai tertinggi antara data aktual vs baku mutu,
  // lalu tambah padding 20% supaya tidak terpotong di atas.
  return Math.ceil(Math.max(dataMax, limitVal) * 1.2);
}

function renderLiveCharts() {
  const configs = [
    { key: 'pm',  id: 'gChartPM' },
    { key: 'co',  id: 'gChartCO' },
    { key: 'so2', id: 'gChartSO2' },
    { key: 'nox', id: 'gChartNOx' }
  ];

  configs.forEach(c => {
    const canvas = document.getElementById(c.id);
    if (!canvas) return;

    const dynamicMax = calcDynamicMax(session[c.key], LIMIT[c.key]);
    const limitLine    = session.labels.map(() => LIMIT[c.key]);
    const baselineLine = session.labels.map(() => BASELINE[c.key]);

    if (liveCharts[c.key]) {
      liveCharts[c.key].data.labels = session.labels;
      liveCharts[c.key].data.datasets[0].data = session[c.key];
      liveCharts[c.key].data.datasets[1].data = limitLine;
      liveCharts[c.key].data.datasets[2].data = baselineLine;
      liveCharts[c.key].options.scales.y.max = dynamicMax;
      liveCharts[c.key].update();
    } else {
      liveCharts[c.key] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: session.labels,
          datasets: [
            { data: session[c.key], borderColor: GAS_COLOR[c.key].line, backgroundColor: GAS_COLOR[c.key].bg, fill: true, tension: 0, pointRadius: 1.5, borderWidth: 2 },
            { data: limitLine,    borderColor: 'rgba(160,175,200,0.5)', borderDash: [5, 3], borderWidth: 1,   pointRadius: 0, fill: false },
            { data: baselineLine, borderColor: '#0d9488',               borderDash: [3, 4], borderWidth: 1.2, pointRadius: 0, fill: false }
          ]
        },
        options: makeOpts(dynamicMax)
      });
    }

    const valEl = document.querySelector(`#${c.id}`).closest('.gchart-card')?.querySelector('.gchart-val');
    if (valEl && session[c.key].length) {
      valEl.textContent = `${session[c.key][session[c.key].length - 1]} mg/Nm\u00b3`;
    }
  });
}

// ============================================================
// COMPLIANCE BANNER + ALERT LIST (dashboard)
// ============================================================
function renderComplianceBanner(payload) {
  const banner = document.querySelector('.compliance-banner');
  const text = document.querySelector('.compliance-banner-text');
  if (!banner || !text) return;

  banner.classList.remove('safe', 'warn', 'danger');

  if (payload.noCombustion) {
    banner.classList.add('safe');
    text.innerHTML = '<strong>Tidak Ada Pembakaran.</strong> Sensor tidak mendeteksi aktivitas pembakaran saat ini.';
    return;
  }

  const overall = payload.overall;
  banner.classList.add(overall.color);
  text.innerHTML = `<strong>${overall.text}.</strong> Standar PP No. 22/2021 dan PermenLHK No. 70/2016.`;
}

function renderAlertList(payload) {
  const list = document.querySelector('.alert-list');
  if (!list) return;

  if (payload.noCombustion) {
    list.innerHTML = `<div class="alert-row warning"><span class="alert-row-time">${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</span><span class="alert-row-msg">Tidak ada pembakaran terdeteksi</span></div>`;
    return;
  }

  const overall = payload.overall;
  const time = payload.time?.slice(0, 5) || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  const rows = [];

  overall.exceeded.forEach(k => {
    rows.push(`<div class="alert-row danger"><span class="alert-row-time">${time}</span><span class="alert-row-msg">${NAMES[k]} melebihi baku mutu</span></div>`);
  });

  overall.approaching.forEach(k => {
    rows.push(`<div class="alert-row warning"><span class="alert-row-time">${time}</span><span class="alert-row-msg">${NAMES[k]} mendekati baku mutu</span></div>`);
  });

  if (rows.length === 0) {
    list.innerHTML = `<div class="alert-row" style="background:var(--neutral-100);color:var(--neutral-600)"><span class="alert-row-time">${time}</span><span class="alert-row-msg">Semua parameter normal</span></div>`;
  } else {
    // alert terbaru di atas, simpan maksimal 8 baris
    list.innerHTML = rows.join('') + list.innerHTML;
    const allRows = [...list.querySelectorAll('.alert-row')].slice(0, 8);
    list.innerHTML = allRows.map(r => r.outerHTML).join('');
  }
}

// ============================================================
// PARAM CARDS (ringkasan angka)
// ============================================================
function renderParamCards(payload) {
  const grid = document.querySelector('.params-grid');
  if (!grid) return;

  if (payload.noCombustion) {
    grid.querySelectorAll('.param-card').forEach(card => {
      card.classList.remove('warn', 'danger');
      const val = card.querySelector('.param-value');
      const pct = card.querySelector('.param-pct');
      const bar = card.querySelector('.param-bar-fill');
      const ppm = card.querySelector('.param-ppm');
      if (val) val.innerHTML = '\u2014 <span class="param-unit">mg/Nm\u00b3</span>';
      if (pct) pct.textContent = '0%';
      if (bar) bar.style.width = '0%';
      if (ppm) ppm.textContent = '\u2014 ppm';
    });
    return;
  }

  const cardMap = {
    pm:  grid.children[0],
    so2: grid.children[1],
    nox: grid.children[2],
    co:  grid.children[3]
  };

  Object.entries(cardMap).forEach(([key, card]) => {
    if (!card) return;
    const g = payload.gases[key];
    card.classList.remove('warn', 'danger');
    if (g.status === 'danger') card.classList.add('danger');
    else if (g.status === 'warn') card.classList.add('warn');

    const val = card.querySelector('.param-value');
    const pct = card.querySelector('.param-pct');
    const bar = card.querySelector('.param-bar-fill');
    const ppm = card.querySelector('.param-ppm');

    if (val) val.innerHTML = `${g.value} <span class="param-unit">mg/Nm\u00b3</span>`;
    if (pct) pct.textContent = `${g.percent}%`;
    if (bar) bar.style.width = `${Math.min(g.percent, 100)}%`;
    if (ppm) {
      const ppmValue = mgNm3ToPpm(g.value, key);
      if (ppmValue !== null) ppm.textContent = `${ppmValue} ppm`;
    }
  });
}

// ============================================================
// STATUS PILL (header: "Pembakaran Aktif" / "Tidak Ada Pembakaran")
// ============================================================
function renderStatusPill(payload) {
  const pill = document.querySelector('.status-pill');
  if (!pill) return;

  const span = pill.querySelector('span');
  pill.classList.remove('active-burn');

  if (payload.noCombustion) {
    if (span) span.textContent = 'Tidak Ada Pembakaran';
  } else {
    pill.classList.add('active-burn');
    if (span) span.textContent = 'Pembakaran Aktif';
  }
}

// ============================================================
// MASTER HANDLER — dipanggil setiap kali ada data baru
// (dari socket.io ATAU dari fetch /data saat halaman pertama load)
//
// isNewPoint = true  -> ini data BARU dari sensor (lewat socket.io),
//                       boleh ditambahkan sebagai titik baru di chart.
// isNewPoint = false -> ini cuma "data terakhir yang sudah pernah ada"
//                       (dipakai saat halaman baru dibuka via fetch
//                       /data), jadi update UI/badge saja TANPA
//                       menambah titik baru ke chart — supaya chart
//                       tidak menulis ulang/duplikat saat pindah
//                       halaman lalu balik lagi.
// ============================================================
function handleEmisiUpdate(payload, isNewPoint = true) {
  renderStatusPill(payload);
  renderComplianceBanner(payload);
  renderAlertList(payload);
  renderParamCards(payload);

  if (isNewPoint) {
    if (payload.noCombustion) {
      // Only reset session when this is an actual zero-reading from sensor.
      // If server emits an idle broadcast (no new data), it sets `idle: true`.
      if (!payload.idle) resetSession();
    } else {
      pushPoint(payload.gases);
    }
    // Akumulasi pelanggaran hanya relevan diperbarui saat ada data baru
    // (bukan tiap polling 3 detik tanpa perubahan apa pun).
    if (document.getElementById('accumList')) loadExceedanceCount();

    // Report HANYA ikut update real-time kalau sedang menampilkan
    // siklus live (hari ini, siklus terbaru). Kalau pengguna sedang
    // melihat histori tanggal/siklus lain, biarkan chart Report statis.
    if (document.getElementById('rChartCO') && reportIsLiveView) {
      if (payload.noCombustion) {
        if (!payload.idle) {
          // Sensor baru saja berhenti (siklus selesai) -> mulai sesi baru.
          reportSession = { labels: [], pm: [], co: [], so2: [], nox: [] };
        }
      } else {
        const label = (payload.time || '').slice(0, 5) || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        reportSession.labels.push(label);
        reportSession.pm.push(payload.gases.pm.value);
        reportSession.co.push(payload.gases.co.value);
        reportSession.so2.push(payload.gases.so2.value);
        reportSession.nox.push(payload.gases.nox.value);
      }
    }
  }

  if (document.getElementById('gChartCO')) renderLiveCharts();
  if (document.getElementById('rChartCO') && reportIsLiveView) renderReportCharts();
}

// ============================================================
// AKUMULASI PELANGGARAN — dihitung langsung dari `session` (data
// chart live yang ada di memory), bukan fetch ke server.
// Logikanya sama persis dengan grafik: reset saat sesi baru (noCombustion),
// akumulasi bertambah real-time setiap data baru masuk.
// ============================================================
function loadExceedanceCount() {
  const list = document.getElementById('accumList');
  if (!list) return;

  const ACCUM_NAMES = { pm: 'PM', so2: 'SO\u2082', nox: 'NO\u2093', co: 'CO' };
  const order = ['pm', 'so2', 'nox', 'co'];

  // Hitung langsung dari session (data grafik live di memory).
  // Reset otomatis ikut dengan resetSession() saat noCombustion.
  list.innerHTML = order.map(key => {
    const count = (session[key] || []).filter(v => Number(v) > LIMIT[key]).length;
    const hasCount = count > 0 ? 'has-count' : '';
    return `<div class="accum-row ${hasCount}"><span class="accum-name">${ACCUM_NAMES[key]}</span><span class="accum-count">${count}&times;</span></div>`;
  }).join('');
}

// ============================================================
// REPORT PAGE CHARTS — punya STATE SENDIRI (reportSession), terpisah
// dari `session` yang dipakai Dashboard. Ini penting karena Report
// bisa menampilkan HISTORI tanggal/siklus lama yang harus tetap statis
// walau Dashboard menerima data baru lewat Socket.IO secara bersamaan.
// ============================================================
let reportCharts = { pm: null, co: null, so2: null, nox: null };
let reportSession = { labels: [], pm: [], co: [], so2: [], nox: [] };

// Apakah Report SEDANG menampilkan siklus aktif/live hari ini. Kalau
// true, chart Report ikut menerima update real-time dari Socket.IO.
// Kalau false (sedang melihat histori tanggal/siklus lain), chart
// Report statis — tidak diubah oleh data baru yang masuk.
let reportIsLiveView = true;

function renderReportCharts() {
  const configs = [
    { key: 'pm',  id: 'rChartPM' },
    { key: 'co',  id: 'rChartCO' },
    { key: 'so2', id: 'rChartSO2' },
    { key: 'nox', id: 'rChartNOx' }
  ];

  configs.forEach(c => {
    const canvas = document.getElementById(c.id);
    if (!canvas) return;

    const dynamicMax   = calcDynamicMax(reportSession[c.key], LIMIT[c.key]);
    const limitLine    = reportSession.labels.map(() => LIMIT[c.key]);
    const baselineLine = reportSession.labels.map(() => BASELINE[c.key]);

    if (reportCharts[c.key]) {
      reportCharts[c.key].data.labels = reportSession.labels;
      reportCharts[c.key].data.datasets[0].data = reportSession[c.key];
      reportCharts[c.key].data.datasets[1].data = limitLine;
      reportCharts[c.key].data.datasets[2].data = baselineLine;
      reportCharts[c.key].options.scales.y.max = dynamicMax;
      reportCharts[c.key].update();
    } else {
      reportCharts[c.key] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: reportSession.labels,
          datasets: [
            { data: reportSession[c.key], borderColor: GAS_COLOR[c.key].line, backgroundColor: GAS_COLOR[c.key].bg, fill: true, tension: 0, pointRadius: 1.5, borderWidth: 2 },
            { data: limitLine,    borderColor: 'rgba(160,175,200,0.5)', borderDash: [5, 3], borderWidth: 1,   pointRadius: 0, fill: false },
            { data: baselineLine, borderColor: '#0d9488',               borderDash: [3, 4], borderWidth: 1.2, pointRadius: 0, fill: false }
          ]
        },
        options: makeOpts(dynamicMax)
      });
    }

    const valEl = document.querySelector(`#${c.id}`).closest('.report-chart-card')?.querySelector('.report-chart-val');
    if (valEl) {
      valEl.textContent = reportSession[c.key].length
        ? `${reportSession[c.key][reportSession[c.key].length - 1]}`
        : '\u2014';
    }
  });
}

// ============================================================
// NAVIGASI SIKLUS PEMBAKARAN (Report) — pilih tanggal, lalu geser
// antar siklus pembakaran di tanggal itu (siklus = rangkaian data
// yang dipisahkan oleh periode "tidak ada pembakaran").
// ============================================================
let cycleList = [];
let cycleIndex = 0;
let cycleDate = new Date().toISOString().slice(0, 10);

function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0, 10);
}

async function loadCyclesForDate(date) {
  try {
    const res = await fetch(`/combustion-cycles?date=${date}`);
    const data = await res.json();
    return data.cycles || [];
  } catch {
    return [];
  }
}

async function loadCycleData(date, index) {
  try {
    const res = await fetch(`/cycle-data?date=${date}&cycle=${index}`);
    return await res.json();
  } catch {
    return { labels: [], pm: [], co: [], so2: [], nox: [] };
  }
}

function updateCycleLabel() {
  const label = document.getElementById('cycleLabel');
  const prevBtn = document.getElementById('cyclePrevBtn');
  const nextBtn = document.getElementById('cycleNextBtn');
  if (!label) return;

  if (cycleList.length === 0) {
    label.textContent = 'Tidak ada data';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const c = cycleList[cycleIndex];
  label.textContent = `Pembakaran ${cycleIndex + 1}/${cycleList.length} (${c.startTime}\u2013${c.endTime})`;

  if (prevBtn) prevBtn.disabled = (cycleIndex <= 0);
  if (nextBtn) nextBtn.disabled = (cycleIndex >= cycleList.length - 1);
}

// Memuat ulang daftar siklus untuk tanggal yang dipilih, lalu otomatis
// menampilkan siklus TERAKHIR (paling baru) di tanggal itu sebagai default.
async function refreshCyclesAndShowLatest(date) {
  cycleDate = date;
  cycleList = await loadCyclesForDate(date);
  cycleIndex = cycleList.length > 0 ? cycleList.length - 1 : 0;
  updateCycleLabel();
  await showCurrentCycle();
}

// Menampilkan siklus yang sedang dipilih (cycleDate + cycleIndex) ke
// chart Report. Menentukan juga apakah ini "live" (siklus terakhir di
// tanggal hari ini) sehingga chart boleh menerima update real-time.
async function showCurrentCycle() {
  if (cycleList.length === 0) {
    reportSession = { labels: [], pm: [], co: [], so2: [], nox: [] };
    reportIsLiveView = false;
    renderReportCharts();
    renderCycleTable([]);
    return;
  }

  const data = await loadCycleData(cycleDate, cycleIndex);
  reportSession = {
    labels: data.labels || [],
    pm: data.pm || [],
    co: data.co || [],
    so2: data.so2 || [],
    nox: data.nox || []
  };

  reportIsLiveView = isToday(cycleDate) && (cycleIndex === cycleList.length - 1);

  renderReportCharts();

  // Tabel ikut siklus yang dipilih — ambil dari raw rows yang dikirim server
  // (kalau ada), atau render ulang dari reportSession sebagai fallback.
  renderCycleTable(data.rows || null);
}

// Render tabel dari baris raw data siklus yang dipilih.
// rows = array { date, time, pm, so2, nox, co, exceeded[] } dari server.
// Kalau null (server belum kirim rows), bangun dari reportSession.
function renderCycleTable(rows) {
  const tbody = document.getElementById('tbody');
  if (!tbody) return;

  // Fallback: bangun dari reportSession kalau server tidak kirim rows
  if (!rows) {
    // Format cycleDate (YYYY-MM-DD) ke DD/MM/YYYY supaya konsisten
    // dengan format tanggal yang dikembalikan server dari DB.
    const [y, m, d] = cycleDate.split('-');
    const dateFormatted = `${d}/${m}/${y}`;

    rows = reportSession.labels.map((label, i) => ({
      date: dateFormatted,
      time: label,
      pm:   reportSession.pm[i] ?? '-',
      so2:  reportSession.so2[i] ?? '-',
      nox:  reportSession.nox[i] ?? '-',
      co:   reportSession.co[i] ?? '-',
      exceeded: [
        reportSession.pm[i]  > LIMIT.pm  ? 'PM'  : null,
        reportSession.co[i]  > LIMIT.co  ? 'CO'  : null,
        reportSession.so2[i] > LIMIT.so2 ? 'SO₂' : null,
        reportSession.nox[i] > LIMIT.nox ? 'NOₓ' : null,
      ].filter(Boolean)
    }));
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--neutral-500)">Tidak ada data untuk siklus ini</td></tr>`;
    applyTableSearch();
    return;
  }

  const rowsHTML = rows.map(r => {
    const isNoCombustion = Number(r.pm) <= 0 && Number(r.co) <= 0 && Number(r.so2) <= 0 && Number(r.nox) <= 0;
    let statusHTML;
    if (isNoCombustion) {
      statusHTML = `<span class="st-dot ok"></span>Tidak Ada Pembakaran`;
    } else if (r.exceeded && r.exceeded.length > 0) {
      statusHTML = `<span class="st-dot warn"></span>${r.exceeded.join(', ')} melebihi baku mutu`;
    } else {
      statusHTML = `<span class="st-dot ok"></span>Normal`;
    }
    return `<tr>
      <td>${r.date}</td>
      <td>${r.time}</td>
      <td>${r.pm}</td>
      <td>${r.so2}</td>
      <td>${r.nox}</td>
      <td>${r.co}</td>
      <td>${statusHTML}</td>
    </tr>`;
  });

  tbody.innerHTML = rowsHTML.join('');
  applyTableSearch();
}

function initCycleNav() {
  const dateInput = document.getElementById('cycleDateInput');
  const prevBtn = document.getElementById('cyclePrevBtn');
  const nextBtn = document.getElementById('cycleNextBtn');
  if (!dateInput) return; // halaman ini tidak punya navigasi siklus

  dateInput.value = cycleDate;

  dateInput.addEventListener('change', () => {
    refreshCyclesAndShowLatest(dateInput.value);
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (cycleIndex > 0) {
        cycleIndex -= 1;
        updateCycleLabel();
        showCurrentCycle();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (cycleIndex < cycleList.length - 1) {
        cycleIndex += 1;
        updateCycleLabel();
        showCurrentCycle();
      }
    });
  }

  // Muat siklus untuk tanggal default (hari ini), tampilkan siklus terakhir.
  refreshCyclesAndShowLatest(cycleDate);
}



// ============================================================
// HISTORY TABLE (report page) — status menyebutkan nama gas spesifik
// ============================================================
async function loadHistory() {
  const tbody = document.getElementById('tbody');
  if (!tbody) return;

  let data;
  try { data = await (await fetch('/history')).json(); }
  catch { return; }

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--neutral-500)">Belum ada data</td></tr>`;
    return;
  }

  // Bangun semua baris sebagai array string dulu, baru di-assign ke
  // innerHTML SEKALI di akhir. Memakai `tbody.innerHTML += ...` di
  // dalam loop sangat lambat untuk ratusan baris karena browser harus
  // re-parse ulang seluruh isi tabel di setiap iterasi (kuadratik).
  const rowsHTML = data.map(r => {
    const isNoCombustion = r.pm <= 0 && r.co <= 0 && r.so2 <= 0 && r.nox <= 0;

    let statusHTML;
    if (isNoCombustion) {
      statusHTML = `<span class="st-dot ok"></span>Tidak Ada Pembakaran`;
    } else if (r.exceeded && r.exceeded.length > 0) {
      statusHTML = `<span class="st-dot warn"></span>${r.exceeded.join(', ')} melebihi baku mutu`;
    } else {
      statusHTML = `<span class="st-dot ok"></span>Normal`;
    }

    return `<tr>
      <td>${r.date}</td>
      <td>${r.time}</td>
      <td>${r.pm}</td>
      <td>${r.so2}</td>
      <td>${r.nox}</td>
      <td>${r.co}</td>
      <td>${statusHTML}</td>
    </tr>`;
  });

  tbody.innerHTML = rowsHTML.join('');

  // Terapkan ulang filter search (kalau pengguna sedang mengetik di
  // search box) supaya tetap konsisten setelah tabel di-refresh/reload.
  applyTableSearch();
}

// ============================================================
// FILTER TABEL — search teks dengan fallback ke server.
// Pertama cari di baris yang sudah ada di DOM (cepat).
// Kalau tidak ada hasil, fetch ke /history?q=... untuk cari
// ke seluruh database — supaya data hari lain tetap bisa ditemukan.
// ============================================================
let searchDebounce = null;

function applyTableSearch() {
  const input = document.getElementById('tableSearchInput');
  const tbody = document.getElementById('tbody');
  if (!input || !tbody) return;

  const normalize = (str) => str.toLowerCase().replace(/\b0+(\d)/g, '$1');
  const q = input.value.trim();
  const qNorm = normalize(q);

  // Kalau kosong, tampilkan semua baris yang ada
  if (!q) {
    tbody.querySelectorAll('tr').forEach(r => r.style.display = '');
    return;
  }

  // Cari dulu di DOM yang sudah ada
  let matchCount = 0;
  tbody.querySelectorAll('tr').forEach(row => {
    const match = normalize(row.textContent).includes(qNorm);
    row.style.display = match ? '' : 'none';
    if (match) matchCount++;
  });

  // Kalau tidak ada hasil di DOM, fetch ke server setelah debounce 400ms
  clearTimeout(searchDebounce);
  if (matchCount === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--neutral-500)">Mencari di database...</td></tr>`;
    searchDebounce = setTimeout(async () => {
      try {
        const data = await (await fetch(`/history?q=${encodeURIComponent(q)}`)).json();
        if (!data || data.length === 0) {
          tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--neutral-500)">Tidak ada data untuk "<strong>${q}</strong>"</td></tr>`;
          return;
        }
        const rowsHTML = data.map(r => {
          const isNoCombustion = r.pm <= 0 && r.co <= 0 && r.so2 <= 0 && r.nox <= 0;
          let statusHTML;
          if (isNoCombustion) {
            statusHTML = `<span class="st-dot ok"></span>Tidak Ada Pembakaran`;
          } else if (r.exceeded && r.exceeded.length > 0) {
            statusHTML = `<span class="st-dot warn"></span>${r.exceeded.join(', ')} melebihi baku mutu`;
          } else {
            statusHTML = `<span class="st-dot ok"></span>Normal`;
          }
          return `<tr>
            <td>${r.date}</td><td>${r.time}</td>
            <td>${r.pm}</td><td>${r.so2}</td><td>${r.nox}</td><td>${r.co}</td>
            <td>${statusHTML}</td>
          </tr>`;
        });
        tbody.innerHTML = rowsHTML.join('');
      } catch {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--neutral-500)">Gagal mencari data</td></tr>`;
      }
    }, 400);
  }
}

const tableSearchInput = document.getElementById('tableSearchInput');
if (tableSearchInput) {
  tableSearchInput.addEventListener('input', applyTableSearch);
}

// Insert a history row in real-time when socket emits new reading.
function insertHistoryRow(payload) {
  const tbody = document.getElementById('tbody');
  if (!tbody) return;

  const date = payload.date || new Date().toLocaleDateString('id-ID');
  const time = payload.time || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  let pm = '-'; let so2 = '-'; let nox = '-'; let co = '-';
  let statusHTML = `<span class="st-dot ok"></span>Normal`;

  if (payload.noCombustion) {
    pm = co = so2 = nox = '0';
    statusHTML = `<span class="st-dot ok"></span>Tidak Ada Pembakaran`;
  } else if (payload.gases) {
    pm = payload.gases.pm.value;
    co = payload.gases.co.value;
    so2 = payload.gases.so2.value;
    nox = payload.gases.nox.value;

    const overall = payload.overall || { exceeded: [] };
    if (overall.exceeded && overall.exceeded.length > 0) {
      statusHTML = `<span class="st-dot warn"></span>${overall.exceeded.join(', ')} melebihi baku mutu`;
    }
  }

  const row = document.createElement('tr');
  row.innerHTML = `<td>${date}</td><td>${time}</td><td>${pm}</td><td>${so2}</td><td>${nox}</td><td>${co}</td><td>${statusHTML}</td>`;

  // prepend
  if (tbody.firstChild) tbody.insertBefore(row, tbody.firstChild);
  else tbody.appendChild(row);

  // keep max 50 rows (consistent with server)
  while (tbody.children.length > 50) tbody.removeChild(tbody.lastChild);

  applyTableSearch();
}

// ============================================================
// IDLE TIMEOUT — kalau 3 menit tidak ada data baru dari sensor,
// anggap sistem mati dan update UI ke "Tidak Ada Pembakaran".
// Reset setiap kali data baru masuk.
// ============================================================
let idleTimer = null;
const IDLE_MS = 90 * 1000; // 90 detik (1.5 menit) — disamakan dengan server

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Simulasikan payload noCombustion supaya UI update
    handleEmisiUpdate({ noCombustion: true, idle: true }, false);
  }, IDLE_MS);
}
const socket = (typeof io !== 'undefined') ? io() : null;

if (socket) {
  socket.on('emisi-update', (payload) => {
    const isNewPoint = !payload.initial;
    handleEmisiUpdate(payload, isNewPoint);
    if (isNewPoint) {
      resetIdleTimer();
      if (document.getElementById('tbody')) insertHistoryRow(payload);
    }
  });
}

// Riwayat tabel cukup dimuat sekali saat halaman dibuka; baris baru
// selanjutnya ditambahkan langsung lewat insertHistoryRow() dari Socket.IO.
if (document.getElementById('tbody')) {
  loadHistory();
}

// Dashboard: saat pertama dibuka, langsung tampilkan data siklus
// pembakaran yang sedang aktif (sama kayak Report ambil dari DB).
// Bedanya: tidak disimpan permanen — session hanya di memory,
// reset otomatis saat noCombustion, mulai dari nol saat siklus baru.
(async function initDashboard() {
  if (!document.getElementById('gChartCO')) return;

  // 1. Fetch /data — kalau return {} berarti server tidak punya data aktif
  //    (sensor mati, lastReading sudah di-reset). Jangan tampilkan apa-apa.
  let currentData = null;
  try {
    const raw = await (await fetch('/data')).json();
    // {} = tidak ada data, langsung render kosong
    if (!raw || Object.keys(raw).length === 0) {
      handleEmisiUpdate({ noCombustion: true, idle: true }, false);
      renderLiveCharts();
      return;
    }
    currentData = raw;
    handleEmisiUpdate(currentData, false);
  } catch {}

  // 2. Sistem aktif — ambil histori siklus aktif hari ini dari DB
  if (currentData && !currentData.noCombustion) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const hist = await (await fetch(`/chart-history?points=60&date=${today}`)).json();
      if (hist && hist.labels && hist.labels.length > 0) {
        session = {
          labels: hist.labels,
          pm:  (hist.pm  || []).map(Number),
          co:  (hist.co  || []).map(Number),
          so2: (hist.so2 || []).map(Number),
          nox: (hist.nox || []).map(Number),
        };
      }
    } catch {}
  }

  renderLiveCharts();
  if (document.getElementById('accumList')) loadExceedanceCount();
})();

// Status pill (.status-pill) ada di SEMUA halaman (Dashboard, Report,
// About, Contact), tapi nilainya hardcode di HTML ("Pembakaran Aktif")
// sebagai placeholder. Begitu halaman dibuka (termasuk navigasi dari
// sidebar, yang reload total halaman), status itu harus langsung
// disinkronkan ke kondisi SERVER saat ini — supaya tidak nunjukin
// status basi/default sambil menunggu event Socket.IO berikutnya
// (yang mungkin tidak akan datang sama sekali kalau sensor mati).
(async function syncStatusPillOnLoad() {
  if (!document.querySelector('.status-pill')) return;
  try {
    const raw = await (await fetch('/data')).json();
    if (!raw || Object.keys(raw).length === 0) {
      renderStatusPill({ noCombustion: true, idle: true });
    } else {
      renderStatusPill(raw);
    }
  } catch {}
})();

// Report: inisialisasi navigasi tanggal & siklus pembakaran (mengisi
// dan merender rChartCO/PM/SO2/NOx sendiri lewat showCurrentCycle()).
initCycleNav();

// Report download handler
(function reportDownloadHandler(){
  const btn = document.getElementById('downloadReportBtn');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const typeEl    = document.getElementById('r_type');
    const bulanEl   = document.getElementById('r_bulan');
    const paramsEl  = document.getElementById('r_params');
    const formatEl  = document.getElementById('r_format');

    const typeRaw = typeEl?.value || 'Report Bulanan';
    const format  = (formatEl?.value || 'pdf').toLowerCase();
    let url = `/report/download?format=${encodeURIComponent(format)}`;

    if (typeRaw.toLowerCase().includes('bulanan')) {
      const bulan = bulanEl?.value || (new Date().getMonth() + 1);
      const tahun = new Date().getFullYear();
      url += `&type=bulan&bulan=${bulan}&tahun=${tahun}`;
    } else {
      // Harian: ambil tanggal dari cycleDateInput (tersync dengan grafik)
      // Fallback ke input r_date, lalu hari ini.
      const cycleDate = document.getElementById('cycleDateInput')?.value;
      const rDate     = document.getElementById('r_date')?.value;
      const date      = cycleDate || rDate || new Date().toISOString().slice(0, 10);
      url += `&type=rentang&from=${date}&to=${date}`;
    }

    const params = paramsEl?.value || 'pm,co,so2,nox';
    url += `&params=${encodeURIComponent(params)}`;

    window.open(url, '_blank');
  });
})();

// ============================================================
// ONBOARDING MODAL — muncul sekali saat pertama kali buka web.
// Setelah user klik "Mulai", disimpan ke localStorage supaya
// tidak muncul lagi. Bisa dipanggil ulang dari tombol sidebar.
// ============================================================
(function initOnboarding() {
  const STORAGE_KEY = 'cems_onboard_done';

  function openModal() {
    const modal = document.getElementById('onboardModal');
    if (!modal) return;
    // Paksa reflow supaya transisi CSS berjalan
    modal.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('visible')));
  }

  function closeModal() {
    const modal = document.getElementById('onboardModal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 220);
  }

  // Tombol "Mulai" — tutup modal dan catat sudah pernah dibuka
  document.addEventListener('click', e => {
    if (e.target.closest('#onboardBtnStart') || e.target.closest('#onboardBtnSkip')) {
      localStorage.setItem(STORAGE_KEY, '1');
      closeModal();
    }
    if (e.target.closest('#sidebarGuideBtn')) {
      openModal();
    }
    if (e.target.id === 'onboardModal') {
      closeModal();
    }
  });

  // Tampilkan saat pertama kali (kalau belum pernah lihat)
  if (!localStorage.getItem(STORAGE_KEY)) {
    openModal();
  }
})();