
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const roi = document.getElementById('roi');
const rgbEl = document.getElementById('rgb');
const swatch = document.getElementById('swatch');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('status');
const chemistrySel = document.getElementById('chemistry');
const mappingSel = document.getElementById('mapping');
const samplesTbody = document.querySelector('#samplesTable tbody');
const mqttStatusEl = document.getElementById('mqttStatus');

let stream = null;
let samples = JSON.parse(localStorage.getItem('smartfilm_samples') || '[]');
let lastResult = null;
let mqttClient = null;

// utilities
function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function nowISO(){ return new Date().toISOString(); }

function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d!==0){
    if(max===r) h=((g-b)/d)%6;
    else if(max===g) h=(b-r)/d + 2;
    else h=(r-g)/d + 4;
  }
  h = Math.round((h*60+360)%360);
  const s = max===0?0: d/max;
  return [h, s, max];
}

// original score logic (unchanged)
function anthocyaninScore(h, mapping='standard'){
  const maxH = 260;
  let s = Math.round(clamp((h / maxH) * 100, 0, 100));
  return mapping==='inverse' ? 100 - s : s;
}
function curcuminScore(h, sVal, mapping='standard'){
  const dev = Math.min(180, Math.abs(((h+360)%360) - 60));
  let raw = Math.round((dev/180)*100);
  return mapping==='inverse' ? 100 - raw : raw;
}
function computeScoreForCurrent(h, sVal){
  const chem = chemistrySel.value;
  const mapping = mappingSel.value;
  if(chem==='anthocyanin') return anthocyaninScore(h, mapping);
  if(chem==='curcumin') return curcuminScore(h, sVal, mapping);
  const raw = Math.round((h%360)/3.6);
  return mapping==='inverse' ? 100-raw : raw;
}

// EXACT interpretation rules per your spec
function interpretColor(filmType, r, g, b) {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (filmType === "anthocyanin") {
    if (((h < 30 || h > 330) && s > 0.25 && v > 0.25) || (h >= 330 && s > 0.2)) {
      return "Fresh (Red/Pink, Acidic)";
    }
    if (h >= 260 && h <= 300 && s > 0.15) {
      return "Moderately Fresh (Purple, Neutral)";
    }
    if (h >= 60 && h <= 120 && s > 0.15) {
      return "Spoiled (Greenish-Yellow, Alkaline)";
    }
    if (v > 0.9 && s < 0.08) {
      return "Spoiled (Colorless, Very Alkaline)";
    }
    return "Uncertain";
  }
  if (filmType === "curcumin") {
    if (h >= 40 && h <= 65 && s > 0.25) {
      return "Fresh (Yellow, Acidic/Neutral)";
    }
    if (h >= 15 && h <= 35 && s > 0.35) {
      return "Spoiled (Orange-Red, Alkaline)";
    }
    if (v > 0.9 && s < 0.08) {
      return "Spoiled (Colorless, Very Alkaline)";
    }
    return "Uncertain";
  }
  return "Uncertain";
}

function statusClassFromText(txt){
  if (txt.startsWith("Fresh")) return "ok";
  if (txt.startsWith("Moderately")) return "warn";
  return "bad";
}

function renderSamples(){
  samplesTbody.innerHTML='';
  const last = samples.slice(-5).reverse();
  last.forEach((s,i)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i+1}</td><td>${new Date(s.timestamp).toLocaleString()}</td><td>${s.filmType}</td>
      <td>${s.rgb}</td><td>${s.status}</td>`;
    samplesTbody.appendChild(tr);
  });
}
renderSamples();

document.getElementById('start').onclick = async ()=>{
  try{
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}, audio:false});
    video.srcObject = stream; await video.play();
    loop();
  }catch(e){ alert('Camera access failed: '+e); }
};
document.getElementById('stop').onclick = ()=>{ if(stream){ stream.getTracks().forEach(t=>t.stop()); video.srcObject=null; stream=null; } };

function loop(){
  if(!stream) return;
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w; canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  const size = Number(roi.value) || 220;
  const x = Math.max(0, (w - size)/2);
  const y = Math.max(0, (h - size)/2);
  const img = ctx.getImageData(x, y, Math.min(size,w), Math.min(size,h)).data;
  const Rs=[], Gs=[], Bs=[];
  for(let i=0;i<img.length;i+=4){ Rs.push(img[i]); Gs.push(img[i+1]); Bs.push(img[i+2]); }
  const R = Math.round(mean(Rs)), G = Math.round(mean(Gs)), B = Math.round(mean(Bs));
  const [hH, sS, vV] = rgbToHsv(R,G,B);
  const score = computeScoreForCurrent(hH, sS); // unchanged
  const interpret = interpretColor(chemistrySel.value, R, G, B);
  rgbEl.textContent = `R ${R} · G ${G} · B ${B}`;
  swatch.style.background = `rgb(${R},${G},${B})`;
  scoreEl.textContent = score;
  statusEl.textContent = interpret;
  statusEl.className = 'pill ' + statusClassFromText(interpret);
  lastResult = { timestamp: nowISO(), filmType: chemistrySel.value, rgb: `(${R},${G},${B})`, status: interpret, h: hH, s: sS, score };
  requestAnimationFrame(loop);
}

// Save sample
document.getElementById('save').onclick = ()=>{
  if(!lastResult){ alert('No reading to save'); return; }
  samples.push(lastResult);
  localStorage.setItem('smartfilm_samples', JSON.stringify(samples));
  renderSamples();
  if(mqttClient && mqttClient.connected){
    const topic = document.getElementById('mqttTopic').value || 'smartfilm/demo';
    try{ mqttClient.publish(topic, JSON.stringify(lastResult)); }catch(e){ console.warn('MQTT publish failed', e); }
  }
  alert('Sample saved');
};

// Export CSV
document.getElementById('export').onclick = ()=>{
  if(samples.length===0){ alert('No samples to export'); return; }
  const header = ['timestamp','filmType','rgb','status','h','s','score'];
  const rows = [header.join(',')].concat(samples.map(r=> [r.timestamp,r.filmType,r.rgb,r.status,r.h,r.s,r.score].join(',')));
  const blob = new Blob([rows.join('\n')], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'smartfilm_samples.csv'; a.click();
};

// Clear data
document.getElementById('clear').onclick = ()=>{
  if(!confirm('Clear all saved samples?')) return;
  samples = []; localStorage.removeItem('smartfilm_samples'); renderSamples();
};

// MQTT connect/disconnect
document.getElementById('btnConnect').onclick = ()=>{
  const server = document.getElementById('mqttServer').value.trim() || 'wss://broker.emqx.io:8084/mqtt';
  const topic = document.getElementById('mqttTopic').value.trim() || 'smartfilm/demo';
  const clientId = (document.getElementById('mqttClientId').value || ('film-'+Math.random().toString(16).slice(2))).trim();
  const username = document.getElementById('mqttUser').value || undefined;
  try{
    mqttClient = mqtt.connect(server, { clientId, username, reconnectPeriod: 5000 });
    mqttClient.on('connect', ()=>{ mqttStatusEl.textContent = `MQTT: connected to ${server} (topic ${topic})`; });
    mqttClient.on('reconnect', ()=>{ mqttStatusEl.textContent = 'MQTT: reconnecting...'; });
    mqttClient.on('error', (e)=>{ mqttStatusEl.textContent = 'MQTT: error ' + e; });
    mqttClient.on('close', ()=>{ mqttStatusEl.textContent = 'MQTT: disconnected'; });
  }catch(e){ mqttStatusEl.textContent = 'MQTT: connection failed'; console.error(e); }
};

document.getElementById('btnDisconnect').onclick = ()=>{
  try{ mqttClient && mqttClient.end(true); mqttClient = null; mqttStatusEl.textContent = 'MQTT: disconnected'; }catch(e){}
};

// initial render
renderSamples();
