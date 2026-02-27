import { drawGrid, redrawTrack } from './canvas.js';
import { 
    initAudio, audioCtx, masterGain, analyser, fxNodes, trackSends, trackAnalysers,
    connectTrackToFX, getDistortionCurve, mapYToFrequency, quantizeFrequency,
    updateReverbDecay
} from './audio.js';
import { setupKnob, updatePadUI, resetFXUI } from './ui.js';
import { initMidiEngine } from './midi.js';

let patternBanks = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null] };
let isPlaying = false, isSaveMode = false, playbackStartTime = 0, playbackDuration = 0;
let undoStack = [], liveNodes = [], liveGainNode = null, activeNodes = [], lastAvg = 0;
let currentTargetTrack = 0, traceCurrentY = 50, isTracing = false, isEffectMode = false, traceCurrentSeg = null, queuedPattern = null;

let activeWaveShapers = []; 
let lastParticleTime = 0; 

const workerCode = `
  let timerID = null;
  self.onmessage = function(e) {
    if (e.data === 'start') {
      if (!timerID) timerID = setInterval(() => postMessage('tick'), 16);
    } else if (e.data === 'stop') {
      clearInterval(timerID); timerID = null;
    }
  };
`;
const timerWorker = new Worker(URL.createObjectURL(new Blob([workerCode], {type: 'application/javascript'})));
timerWorker.onmessage = () => { if (isPlaying) loop(); };

const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const chordColors = ['#FF5733', '#33FF57', '#3357FF'];

const toolSelect = document.getElementById("toolSelect"),
      brushSelect = document.getElementById("brushSelect"),
      sizeSlider = document.getElementById("brushSizeSlider"),
      chordSelect = document.getElementById("chordSelect"),
      harmonizeCheckbox = document.getElementById("harmonizeCheckbox"),
      scaleSelect = document.getElementById("scaleSelect"),
      pigeonImg = document.getElementById("pigeon"),
      tracePad = document.getElementById("trace-pad"),
      customEraser = document.getElementById("custom-eraser");

const tracks = Array.from(document.querySelectorAll(".track-container")).map((c, i) => ({
    index: i, canvas: c.querySelector("canvas"), ctx: c.querySelector("canvas").getContext("2d"),
    segments: [], wave: "sine", mute: false, solo: false, vol: 0.8, snap: false, gainNode: null, curSeg: null
}));

document.addEventListener("DOMContentLoaded", () => {
    tracks.forEach(t => { drawGrid(t); setupTrackControls(t); setupDrawing(t); });
    loadInitialData();
    setupFX();
    setupMainControls();
    setupPads();
    setupTracePad();
    resetFXUI(updateRoutingFromUI);
    document.body.classList.toggle("eraser-mode", toolSelect.value === "erase");
});

function getPos(e, c) {
    const r = c.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX, cy = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (cx - r.left) * (c.width / r.width), y: (cy - r.top) * (c.height / r.height) };
}

function saveState() {
    undoStack.push(JSON.stringify(tracks.map(t => t.segments)));
    if (undoStack.length > 25) undoStack.shift(); 
}

function getKnobVal(fxName, paramName) {
    let val = 0;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes(fxName)) {
            unit.querySelectorAll('.knob').forEach(k => {
                if (k.nextElementSibling && k.nextElementSibling.textContent.trim() === paramName) {
                    val = parseFloat(k.dataset.val || 0.5);
                }
            });
        }
    });
    return val;
}

function getMatrixStateByName(fxName, trackIndex) {
    let isActive = false;
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes(fxName)) {
            const btn = unit.querySelectorAll('.matrix-btn')[trackIndex];
            if (btn && btn.classList.contains('active')) isActive = true;
        }
    });
    return isActive;
}

function setMatrixStateByName(fxName, trackIndex, isActive) {
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes(fxName)) {
            const btn = unit.querySelectorAll('.matrix-btn')[trackIndex];
            if (btn) {
                if (isActive) btn.classList.add('active');
                else btn.classList.remove('active');
            }
            const led = unit.querySelector('.led');
            if (led) led.classList.toggle('on', unit.querySelectorAll('.matrix-btn.active').length > 0);
        }
    });
}

function audioBufferToWav(buffer) {
    let numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44,
        bufferArray = new ArrayBuffer(length), view = new DataView(bufferArray),
        channels = [], i, sample, offset = 0, pos = 0;
    const setUint16 = data => { view.setUint16(pos, data, true); pos += 2; };
    const setUint32 = data => { view.setUint32(pos, data, true); pos += 4; };
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
    setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
    setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - 44);
    for (i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, sample, true); pos += 2;
        }
        offset++;
    }
    return new Blob([bufferArray], { type: "audio/wav" });
}

window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") {
        e.preventDefault(); 
        if (isPlaying) document.getElementById("stopButton").click();
        else document.getElementById("playButton").click();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        document.getElementById("undoButton").click();
    }
});

toolSelect.addEventListener("change", (e) => {
    document.body.classList.toggle("eraser-mode", e.target.value === "erase");
});

function updateFractalFxUI() {
    const isFractal = brushSelect.value === "fractal";
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes("FRACTAL")) {
            unit.style.transition = "all 0.3s ease";
            unit.style.opacity = isFractal ? "1" : "0.3"; 
            unit.style.boxShadow = isFractal ? "0 0 15px rgba(255, 68, 68, 0.15)" : "none"; 
            unit.style.borderColor = isFractal ? "#ff4444" : "#333"; 
            header.style.color = isFractal ? "#ff4444" : "#666";
            
            const knobs = unit.querySelectorAll('.knob-container');
            knobs.forEach(k => k.style.opacity = isFractal ? "1" : "0.5");
        }
    });
}
brushSelect.addEventListener("change", updateFractalFxUI);
updateFractalFxUI(); 

const updateEraserPos = (e) => {
    if (toolSelect.value === "erase" && customEraser) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        customEraser.style.left = clientX + "px";
        customEraser.style.top = clientY + "px";
    }
};
window.addEventListener("mousemove", updateEraserPos);
window.addEventListener("touchmove", updateEraserPos, { passive: true });

function applyAllVolumes() {
    if (!audioCtx) return;
    const anySolo = tracks.some(tr => tr.solo);
    tracks.forEach(tr => {
        if (tr.gainNode) {
            const isAudible = anySolo ? tr.solo : !tr.mute;
            tr.gainNode.gain.setTargetAtTime(isAudible ? tr.vol : 0, audioCtx.currentTime, 0.05);
        }
    });
}

function applyAllFXFromUI() {
    if (!audioCtx) return;
    
    if (fxNodes.delay) {
        fxNodes.delay.node.delayTime.value = getKnobVal("DELAY", "TIME") * 1.0;
        fxNodes.delay.feedback.gain.value = getKnobVal("DELAY", "FDBK") * 0.9;
    }
    if (fxNodes.reverb) {
        fxNodes.reverb.mix.gain.value = getKnobVal("REVERB", "MIX") * 1.5;
        updateReverbDecay(getKnobVal("REVERB", "DECAY")); 
    }
    if (fxNodes.vibrato) {
        fxNodes.vibrato.lfo.frequency.value = getKnobVal("VIBRATO", "RATE") * 20;
        fxNodes.vibrato.depthNode.gain.value = getKnobVal("VIBRATO", "DEPTH") * 0.01;
    }
    if (fxNodes.filter && fxNodes.filter.node1) {
        const valF = getKnobVal("FILTER", "FREQ");
        const valR = getKnobVal("FILTER", "RES");
        fxNodes.filter.node1.frequency.value = Math.pow(valF, 3) * 22000;
        fxNodes.filter.node2.frequency.value = Math.pow(valF, 3) * 22000;
        fxNodes.filter.node1.Q.value = valR * 15;
        fxNodes.filter.node2.Q.value = valR * 15;
    }
    if (fxNodes.stutter) {
        fxNodes.stutter.lfo.frequency.value = (getKnobVal("STUTTER", "RATE") * 15) + 1;
    }
    updateRoutingFromUI();
}

function loadInitialData() {
    fetch('default_set.json')
        .then(res => res.json())
        .then(data => {
            if (data.banks) { 
                patternBanks = data.banks; 
                updatePadUI(patternBanks); 
            }
            if (data.current) {
                loadPatternData(data.current);
            }
            let foundActive = false;
            for (let bank of ['A', 'B', 'C']) {
                for (let i = 0; i < 4; i++) {
                    if (patternBanks[bank] && patternBanks[bank][i]) {
                        const padElem = document.querySelector(`.pad[data-bank="${bank}"][data-idx="${i}"]`);
                        if (padElem) padElem.classList.add("active");
                        foundActive = true;
                        break;
                    }
                }
                if (foundActive) break;
            }
        })
        .catch(() => console.log("Default-Set nicht gefunden. Starte mit leerem Canvas."));
}

function loadPatternData(d) {
    if (d.settings) {
        document.getElementById("bpmInput").value = d.settings.bpm;
        document.getElementById("loopCheckbox").checked = d.settings.loop;
        scaleSelect.value = d.settings.scale;
        harmonizeCheckbox.checked = d.settings.harmonize;
        document.getElementById("scaleSelectContainer").style.display = harmonizeCheckbox.checked ? "inline" : "none";
        playbackDuration = (60 / (parseFloat(d.settings.bpm) || 120)) * 32;
    }
    
    if (d.fx) {
        if (d.fx.matrix) {
            d.fx.matrix.forEach((m, i) => {
                setMatrixStateByName("DELAY", i, m.delay || false);
                setMatrixStateByName("REVERB", i, m.reverb || false);
                setMatrixStateByName("VIBRATO", i, m.vibrato || false);
                setMatrixStateByName("FILTER", i, m.filter || false);
                setMatrixStateByName("STUTTER", i, m.stutter || false);
            });
        }
        
        const updateKnob = (fxName, paramName, rawVal, multiplier) => {
            document.querySelectorAll('.fx-unit').forEach(unit => {
                const header = unit.querySelector('.fx-header');
                if (header && header.textContent.toUpperCase().includes(fxName)) {
                    unit.querySelectorAll('.knob').forEach(knob => {
                        if (knob.nextElementSibling && knob.nextElementSibling.textContent.trim() === paramName) {
                            const normVal = rawVal / multiplier;
                            knob.dataset.val = normVal;
                            knob.style.transform = `rotate(${-135 + (normVal * 270)}deg)`;
                        }
                    });
                }
            });
        };

        if (d.fx.delay) { updateKnob("DELAY", "TIME", d.fx.delay.time, 1.0); updateKnob("DELAY", "FDBK", d.fx.delay.feedback, 0.9); }
        if (d.fx.reverb) { updateKnob("REVERB", "MIX", d.fx.reverb.mix, 1.5); updateKnob("REVERB", "DECAY", d.fx.reverb.decay !== undefined ? d.fx.reverb.decay : 0.5, 1.0); }
        if (d.fx.vibrato) { updateKnob("VIBRATO", "RATE", d.fx.vibrato.rate, 20); updateKnob("VIBRATO", "DEPTH", d.fx.vibrato.depth, 0.01); }
        if (d.fx.filter) { updateKnob("FILTER", "FREQ", d.fx.filter.freq, 1.0); updateKnob("FILTER", "RES", d.fx.filter.res, 1.0); }
        if (d.fx.stutter) { updateKnob("STUTTER", "RATE", d.fx.stutter.rate, 1.0); updateKnob("STUTTER", "MIX", d.fx.stutter.mix, 1.0); }
        if (d.fx.fractal) { updateKnob("FRACTAL", "CHAOS", d.fx.fractal.chaos, 1.0); updateKnob("FRACTAL", "MORPH", d.fx.fractal.morph, 1.0); }

        applyAllFXFromUI();
    }

    const tData = d.tracks || d;
    if (Array.isArray(tData)) {
        tData.forEach((td, idx) => {
            if (!tracks[idx]) return;
            let t = tracks[idx]; t.segments = JSON.parse(JSON.stringify(td.segments || td || []));
            if (!Array.isArray(td)) { t.vol = td.vol ?? 0.8; t.mute = td.mute ?? false; t.wave = td.wave ?? "sine"; t.snap = td.snap ?? false; }
            
            const cont = t.canvas.closest('.track-container');
            if (cont) {
                cont.querySelector(".volume-slider").value = t.vol;
                const muteBtn = cont.querySelector(".mute-btn");
                if (muteBtn) muteBtn.classList.toggle("active", t.mute);
                const soloBtn = cont.querySelector(".btn--solo");
                if (soloBtn) soloBtn.classList.toggle("active", t.solo);
                const snapBox = cont.querySelector(".snap-checkbox"); if(snapBox) snapBox.checked = t.snap;
                cont.querySelectorAll(".wave-btn").forEach(btn => {
                    if (btn.dataset.wave === t.wave) btn.classList.add("active");
                    else btn.classList.remove("active");
                });
            }
            redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
        });
        applyAllVolumes();
    }
}

// ==========================================
// AUDIO SYNTHESE (LIVE & PLAYBACK)
// ==========================================

function startLiveSynth(track, x, y) {
    const anySolo = tracks.some(t => t.solo);
    const isAudible = anySolo ? track.solo : !track.mute;
    if (!isAudible || track.vol < 0.01) return;
    
    liveNodes = []; liveGainNode = audioCtx.createGain(); liveGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    
    const brush = brushSelect.value;
    const maxVol = brush === "xenakis" ? 0.15 : 0.3;
    liveGainNode.gain.linearRampToValueAtTime(maxVol, audioCtx.currentTime + 0.01);
    
    let currentY = y;
    if (brush === "fractal" && track.curSeg && track.curSeg.points.length > 0) {
        const fractalChaos = getKnobVal("FRACTAL", "CHAOS") || 0;
        const p = track.curSeg.points[track.curSeg.points.length - 1];
        currentY += (p.rY || 0) * 100 * fractalChaos;
    }
    
    let freq = mapYToFrequency(currentY, 100); 
    if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    
    const ivs = (brush === "chord") ? chordIntervals[chordSelect.value] : (brush === "xenakis" ? [0, 1, 2, 3, 4] : [0]);

    ivs.forEach((iv, i) => {
        const osc = audioCtx.createOscillator(); 
        osc.type = track.wave;

        let finalDetune = 0;
        if (brush === "xenakis") {
            const offset = i - 2; 
            const waveMod = Math.sin(x * 0.04 + offset * 1.5);
            finalDetune = (offset * 0.05) + (waveMod * 0.15); 
        } else if (brush === "chord") {
            finalDetune = iv;
        }

        osc.frequency.setValueAtTime(freq * Math.pow(2, finalDetune / 12), audioCtx.currentTime);
        osc.connect(liveGainNode); 
        osc.start(); liveNodes.push(osc);
    });
    
    const trackG = audioCtx.createGain(); 
    trackG.gain.value = track.vol;
    liveGainNode.connect(trackG); 
    connectTrackToFX(trackG, track.index); 
    liveGainNode.out = trackG;
}

function updateLiveSynth(track, x, y) {
    if (!liveGainNode) return;
    
    let currentY = y;
    const brush = brushSelect.value;
    if (brush === "fractal" && track.curSeg && track.curSeg.points.length > 0) {
        const fractalChaos = getKnobVal("FRACTAL", "CHAOS") || 0;
        const p = track.curSeg.points[track.curSeg.points.length - 1];
        currentY += (p.rY || 0) * 100 * fractalChaos;
    }

    let freq = mapYToFrequency(currentY, 100); 
    if (harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value);
    
    liveNodes.forEach((n, i) => { 
        let finalDetune = 0;
        if (brush === "xenakis") {
            const offset = i - 2; 
            const waveMod = Math.sin(x * 0.04 + offset * 1.5);
            finalDetune = (offset * 0.05) + (waveMod * 0.15);
        } else if (brush === "chord") {
            const ivs = chordIntervals[chordSelect.value] || [0];
            finalDetune = ivs[i] || 0;
        }
        n.frequency.setTargetAtTime(freq * Math.pow(2, finalDetune / 12), audioCtx.currentTime, 0.02); 
    });
}

function stopLiveSynth() {
    if (!liveGainNode) return;
    const gn = liveGainNode; 
    const ns = liveNodes; 
    gn.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    setTimeout(() => { 
        ns.forEach(n => { try { n.stop(); n.disconnect(); } catch(e){} }); 
        if (gn.out) gn.out.disconnect(); 
        gn.disconnect(); 
    }, 100);
    liveNodes = []; 
    liveGainNode = null;
}

function triggerParticleGrain(track, y) { 
    const anySolo = tracks.some(t => t.solo);
    const isAudible = anySolo ? track.solo : !track.mute;
    if (!isAudible || track.vol < 0.01) return; 
    let freq = mapYToFrequency(y, 100); 
    if(harmonizeCheckbox.checked) freq = quantizeFrequency(freq, scaleSelect.value); 
    const osc = audioCtx.createOscillator(); osc.type = track.wave; osc.frequency.value = freq; 
    const env = audioCtx.createGain(); const now = audioCtx.currentTime;
    env.gain.setValueAtTime(0, now); 
    env.gain.linearRampToValueAtTime(0.4, now + 0.01); 
    env.gain.exponentialRampToValueAtTime(0.01, now + 0.15); 
    const trackG = audioCtx.createGain(); trackG.gain.value = track.vol;
    osc.connect(env).connect(trackG); 
    connectTrackToFX(trackG, track.index);
    osc.onended = () => { const idx = activeNodes.indexOf(osc); if (idx > -1) activeNodes.splice(idx, 1); };
    osc.start(now); osc.stop(now + 0.2); 
    activeNodes.push(osc);
}

function scheduleTracks(start, targetCtx = audioCtx, targetDest = masterGain, offlineFX = null) {
    const anySolo = tracks.some(tr => tr.solo);
    tracks.forEach(track => {
        const trkG = targetCtx.createGain(); 
        trkG.gain.value = (track.mute || (anySolo && !track.solo)) ? 0 : track.vol;
        
        if (targetCtx === audioCtx) { 
            track.gainNode = trkG; 
            connectTrackToFX(trkG, track.index); 
        } else if (offlineFX) { 
            let dryVol = 1.0;
            const hasFilter = getMatrixStateByName("FILTER", track.index);
            const hasStutter = getMatrixStateByName("STUTTER", track.index);
            
            if (hasFilter) dryVol = 0.0;
            else if (hasStutter) dryVol = 1.0 - getKnobVal("STUTTER", "MIX");
            
            const dryGain = targetCtx.createGain();
            dryGain.gain.value = dryVol;
            trkG.connect(dryGain);
            dryGain.connect(targetDest);

            if (getMatrixStateByName("DELAY", track.index)) trkG.connect(offlineFX.delay);
            if (getMatrixStateByName("VIBRATO", track.index)) trkG.connect(offlineFX.vibrato);
            if (getMatrixStateByName("REVERB", track.index) && offlineFX.reverbInput) trkG.connect(offlineFX.reverbInput); 
            if (hasFilter && offlineFX.filterInput) trkG.connect(offlineFX.filterInput);
            
            if (hasStutter && offlineFX.stutter) {
                const stutterSend = targetCtx.createGain();
                stutterSend.gain.value = getKnobVal("STUTTER", "MIX");
                trkG.connect(stutterSend);
                stutterSend.connect(offlineFX.stutter);
            }
        }
        
        const fractalChaos = getKnobVal("FRACTAL", "CHAOS") || 0;

        track.segments.forEach(seg => {
            const brush = seg.brush || "standard", sorted = seg.points.slice().sort((a, b) => a.x - b.x);
            if (sorted.length < 2 && brush !== "particles") return;
            
            if (brush === "particles") {
                seg.points.forEach(p => {
                    const t = Math.max(0, start + (p.x / 750) * playbackDuration), osc = targetCtx.createOscillator(), env = targetCtx.createGain();
                    osc.type = track.wave; let f = mapYToFrequency(p.y, 100); if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                    
                    osc.frequency.value = f; 
                    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.4, t + 0.01); env.gain.exponentialRampToValueAtTime(0.01, t + 0.15); 
                    
                    osc.connect(env).connect(trkG); 
                    osc.onended = () => { const idx = activeNodes.indexOf(osc); if (idx > -1) activeNodes.splice(idx, 1); };
                    osc.start(t); osc.stop(t + 0.2); 
                    if (targetCtx === audioCtx) activeNodes.push(osc);
                });
            } else {
                const ivs = (brush === "chord") ? chordIntervals[seg.chordType || "major"] : (brush === "xenakis" ? [0, 1, 2, 3, 4] : [0]);
                
                ivs.forEach((iv, i) => {
                    const osc = targetCtx.createOscillator(), g = targetCtx.createGain(); osc.type = track.wave;
                    
                    let tfPairs = [];
                    sorted.forEach(p => {
                        let cX = p.x, cY = p.y;
                        if (brush === "fractal") {
                            cX += (p.rX || 0) * 50 * fractalChaos;
                            cY += (p.rY || 0) * 100 * fractalChaos;
                        }
                        const t = Math.max(0, start + (cX / 750) * playbackDuration); 
                        let f = mapYToFrequency(cY, 100); 
                        if (harmonizeCheckbox.checked) f = quantizeFrequency(f, scaleSelect.value);
                        tfPairs.push({ t, f, cX }); 
                    });
                    
                    tfPairs.sort((a, b) => a.t - b.t);
                    if (tfPairs.length === 0) return;
                    
                    const sT = tfPairs[0].t;
                    const eT = tfPairs[tfPairs.length - 1].t;

                    const maxVol = brush === "xenakis" ? 0.15 : 0.3;
                    g.gain.setValueAtTime(0, sT); 
                    g.gain.linearRampToValueAtTime(maxVol, sT + 0.02); 
                    g.gain.setValueAtTime(maxVol, eT); 
                    g.gain.linearRampToValueAtTime(0, eT + 0.1);

                    osc.connect(g); 
                    g.connect(trkG); 
                    
                    tfPairs.forEach(pair => {
                        let finalDetune = 0;
                        if (brush === "xenakis") {
                            const offset = i - 2;
                            const waveMod = Math.sin(pair.cX * 0.04 + offset * 1.5);
                            finalDetune = (offset * 0.05) + (waveMod * 0.15);
                        } else if (brush === "chord") {
                            finalDetune = iv;
                        }

                        const playFreq = pair.f * Math.pow(2, finalDetune / 12);
                        try { osc.frequency.linearRampToValueAtTime(playFreq, pair.t); } 
                        catch(e) { osc.frequency.setTargetAtTime(playFreq, pair.t, 0.01); }
                    });
                    
                    osc.onended = () => { const idx = activeNodes.indexOf(osc); if (idx > -1) activeNodes.splice(idx, 1); };
                    osc.start(sT); osc.stop(eT + 0.2); 
                    if (targetCtx === audioCtx) activeNodes.push(osc);
                });
            }
        });
    });
}

function setupDrawing(track) {
    let drawing = false;
    
    const start = e => {
        e.preventDefault(); 
        initAudio(tracks, updateRoutingFromUI); 
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
        saveState(); 
        const pos = getPos(e, track.canvas); 
        const x = track.snap ? Math.round(pos.x / (750 / 32)) * (750 / 32) : pos.x;
        
        if (toolSelect.value === "draw") {
            drawing = true; 
            
            const rX = Math.random() - 0.5;
            const rY = Math.random() - 0.5;

            track.curSeg = { points: [{ x, y: pos.y, rX, rY }], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value };
            track.segments.push(track.curSeg); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
            
            if (brushSelect.value === "particles") {
                triggerParticleGrain(track, pos.y);
                lastParticleTime = performance.now();
            } else {
                startLiveSynth(track, x, pos.y);
            }
        } else {
            erase(track, pos.x, pos.y); 
        }
    };

    const move = e => {
        if (!drawing && toolSelect.value !== "erase") return; 
        const pos = getPos(e, track.canvas); 
        const x = track.snap ? Math.round(pos.x / (750 / 32)) * (750 / 32) : pos.x;
        
        if (drawing && track.curSeg) {
            const lastPt = track.curSeg.points[track.curSeg.points.length - 1];
            const dist = Math.hypot(x - lastPt.x, pos.y - lastPt.y);
            
            if (dist > 3) { 
                const rX = Math.random() - 0.5;
                const rY = Math.random() - 0.5;
                
                track.curSeg.points.push({ x, y: pos.y, rX, rY }); 
                redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors);
                
                if (brushSelect.value === "particles") {
                    const now = performance.now();
                    if (now - lastParticleTime > 16) {
                        triggerParticleGrain(track, pos.y);
                        lastParticleTime = now;
                    }
                } else {
                    updateLiveSynth(track, x, pos.y);
                }
            }
        } else if (toolSelect.value === "erase" && (e.buttons === 1 || e.type === "touchmove")) {
            erase(track, pos.x, pos.y); 
        }
    };

    const stop = () => { 
        if (drawing) { 
            if (track.curSeg && track.curSeg.points.length === 1) {
                track.curSeg.points.push({
                    x: track.curSeg.points[0].x + 0.5, y: track.curSeg.points[0].y, 
                    rX: track.curSeg.points[0].rX, rY: track.curSeg.points[0].rY
                });
            }
            drawing = false; 
            track.curSeg = null; 
            stopLiveSynth(); 
            redrawTrack(track, undefined, brushSelect.value, chordIntervals, chordColors); 
        } 
    };

    track.canvas.addEventListener("mousedown", start); 
    track.canvas.addEventListener("mousemove", move); 
    window.addEventListener("mouseup", stop); 
    track.canvas.addEventListener("mouseleave", stop);
    track.canvas.addEventListener("touchstart", start, {passive:false}); 
    track.canvas.addEventListener("touchmove", move, {passive:false}); 
    track.canvas.addEventListener("touchend", stop);
}

function erase(t, x, y) { 
    t.segments = t.segments.filter(s => !s.points.some(p => Math.hypot(p.x - x, p.y - y) < 20)); 
    redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); 
}

function setupMainControls() {
    const helpBtn = document.getElementById("helpBtn");
    const helpOverlay = document.getElementById("help-overlay");
    const closeHelpBtn = document.getElementById("closeHelpBtn");
    
    if (helpBtn && helpOverlay && closeHelpBtn) {
        helpBtn.addEventListener("click", () => helpOverlay.style.display = "flex");
        closeHelpBtn.addEventListener("click", () => helpOverlay.style.display = "none");
        helpOverlay.addEventListener("click", (e) => { if(e.target === helpOverlay) helpOverlay.style.display = "none"; });
    }

    initMidiEngine("extSyncBtn", "midiInputSelect", {
        onToggle: (active) => {
            const bpmInput = document.getElementById("bpmInput");
            if (bpmInput) bpmInput.disabled = active;
        },
        onBpm: (exactBpm) => {
            playbackDuration = (60 / exactBpm) * 32;
            const bpmInput = document.getElementById("bpmInput");
            if (bpmInput) {
                const displayBpm = Math.round(exactBpm);
                if (bpmInput.value === "" || Math.abs(parseInt(bpmInput.value) - displayBpm) >= 1) {
                    bpmInput.value = displayBpm;
                }
            }
        },
        onStart: () => {
            if (!isPlaying) {
                initAudio(tracks, updateRoutingFromUI); 
                applyAllFXFromUI(); 
                if (audioCtx.state === "suspended") audioCtx.resume();
                playbackDuration = (60 / (parseFloat(document.getElementById("bpmInput").value) || 120)) * 32;
                playbackStartTime = audioCtx.currentTime; 
                isPlaying = true; 
                
                activeWaveShapers = []; 
                scheduleTracks(playbackStartTime); 
                
                timerWorker.postMessage('start');
            }
        },
        onStop: () => {
            if (isPlaying) document.getElementById("stopButton").click();
        }
    });

    let mediaRecorder = null;
    let recordedChunks = [];
    const recBtn = document.getElementById("recButton");
    
    if (recBtn) {
        recBtn.addEventListener("click", () => {
            if (!audioCtx) initAudio(tracks, updateRoutingFromUI);
            if (audioCtx.state === "suspended") audioCtx.resume();

            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
                recBtn.innerText = "⏺ Rec";
                recBtn.style.color = ""; 
            } else {
                const dest = audioCtx.createMediaStreamDestination();
                masterGain.connect(dest);
                mediaRecorder = new MediaRecorder(dest.stream);
                recordedChunks = [];

                mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
                mediaRecorder.onstop = async () => {
                    recBtn.innerText = "⏳ Saving...";
                    const webmBlob = new Blob(recordedChunks, { type: "audio/webm" });
                    const arrayBuffer = await webmBlob.arrayBuffer();
                    const decodedAudio = await audioCtx.decodeAudioData(arrayBuffer);
                    const wavBlob = audioBufferToWav(decodedAudio);

                    const url = URL.createObjectURL(wavBlob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "pigeon_live_recording.wav";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    masterGain.disconnect(dest);
                    recBtn.innerText = "⏺ Rec";
                };

                mediaRecorder.start();
                recBtn.innerText = "⏹ Stop Rec";
                recBtn.style.color = "#ff4444";
            }
        });
    }

    const exportWavBtn = document.getElementById("exportWavButton");
    exportWavBtn.addEventListener("click", async () => {
        try {
            exportWavBtn.innerText = "⏳ Exporting...";
            exportWavBtn.disabled = true;

            const bpm = parseFloat(document.getElementById("bpmInput").value) || 120;
            const loopDur = (60 / bpm) * 32;
            const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
            const lengthInSamples = Math.floor(sampleRate * loopDur);
            const offCtx = new OfflineAudioContext(2, lengthInSamples, sampleRate);
            
            const mDest = offCtx.createGain(); 
            mDest.connect(offCtx.destination);
            
            const fxOff = {
                delay: offCtx.createDelay(), delayFbk: offCtx.createGain(),
                vibrato: offCtx.createDelay(), vibLfo: offCtx.createOscillator(), vibDepth: offCtx.createGain(),
                filter: offCtx.createBiquadFilter(), filterDrive: offCtx.createWaveShaper(),
                stutter: offCtx.createGain(), stutterLfo: offCtx.createOscillator()
            };
            
            fxOff.delay.delayTime.value = getKnobVal("DELAY", "TIME") * 1.0;
            fxOff.delayFbk.gain.value = getKnobVal("DELAY", "FDBK") * 0.9;
            fxOff.delay.connect(fxOff.delayFbk); fxOff.delayFbk.connect(fxOff.delay);
            fxOff.delay.connect(mDest);
            
            fxOff.vibrato.delayTime.value = 0.03;
            fxOff.vibLfo.frequency.value = getKnobVal("VIBRATO", "RATE") * 20;
            fxOff.vibDepth.gain.value = getKnobVal("VIBRATO", "DEPTH") * 0.01;
            fxOff.vibLfo.connect(fxOff.vibDepth); fxOff.vibDepth.connect(fxOff.vibrato.delayTime);
            fxOff.vibLfo.start(0); fxOff.vibrato.connect(mDest);

            fxOff.reverbInput = offCtx.createGain();
            fxOff.reverbMix = offCtx.createGain();
            fxOff.reverbMix.gain.value = getKnobVal("REVERB", "MIX") * 1.5;
            fxOff.reverbFilter = offCtx.createBiquadFilter();
            fxOff.reverbFilter.type = 'lowpass';
            fxOff.reverbFilter.frequency.value = 2500;
            
            const revDecay = getKnobVal("REVERB", "DECAY") * 1.0 || 0.5;
            const duration = 0.1 + (revDecay * 4.0);
            const len = Math.floor(sampleRate * duration);
            const impulse = offCtx.createBuffer(2, len, sampleRate);
            for (let i = 0; i < 2; i++) {
                const chan = impulse.getChannelData(i);
                for (let j = 0; j < len; j++) chan[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3);
            }
            fxOff.reverbConvolver = offCtx.createConvolver();
            fxOff.reverbConvolver.buffer = impulse;

            fxOff.reverbInput.connect(fxOff.reverbConvolver);
            fxOff.reverbConvolver.connect(fxOff.reverbFilter);
            fxOff.reverbFilter.connect(fxOff.reverbMix);
            fxOff.reverbMix.connect(mDest);

            fxOff.filter.type = 'lowpass';
            const fVal = getKnobVal("FILTER", "FREQ");
            const rVal = getKnobVal("FILTER", "RES");
            fxOff.filter.frequency.value = Math.pow(fVal, 3) * 22000;
            fxOff.filter.Q.value = rVal * 15;
            fxOff.filterDrive.curve = getDistortionCurve(rVal * 50); 
            fxOff.filterDrive.connect(fxOff.filter);
            fxOff.filter.connect(mDest);
            fxOff.filterInput = fxOff.filterDrive; 

            fxOff.stutter.gain.value = 0;
            fxOff.stutterLfo.type = 'square';
            fxOff.stutterLfo.frequency.value = (getKnobVal("STUTTER", "RATE") * 15) + 1;
            const stAmp = offCtx.createGain(); stAmp.gain.value = 0.5;
            const stOff = offCtx.createConstantSource(); stOff.offset.value = 0.5; stOff.start(0);
            fxOff.stutterLfo.connect(stAmp); stAmp.connect(fxOff.stutter.gain); stOff.connect(fxOff.stutter.gain);
            fxOff.stutterLfo.start(0);
            fxOff.stutter.connect(mDest);

            scheduleTracks(0, offCtx, mDest, fxOff);
            
            const renderedBuffer = await offCtx.startRendering();
            const wavBlob = audioBufferToWav(renderedBuffer);
            
            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "pigeon_perfect_loop.wav";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
        } catch(err) {
            console.error("Fehler beim Export:", err);
            alert("Es gab ein Problem beim Exportieren (siehe Konsole).");
        } finally {
            exportWavBtn.innerText = "Export WAV";
            exportWavBtn.disabled = false;
        }
    });

    document.getElementById("playButton").addEventListener("click", () => {
        if (isPlaying) return; 
        initAudio(tracks, updateRoutingFromUI); 
        applyAllFXFromUI(); 
        if (audioCtx.state === "suspended") audioCtx.resume();
        playbackDuration = (60 / (parseFloat(document.getElementById("bpmInput").value) || 120)) * 32;
        playbackStartTime = audioCtx.currentTime + 0.05; 
        isPlaying = true; 
        
        activeWaveShapers = []; 
        scheduleTracks(playbackStartTime); 
        
        timerWorker.postMessage('start');
    });
    
    document.getElementById("stopButton").addEventListener("click", () => {
        isPlaying = false; 
        timerWorker.postMessage('stop');
        activeNodes.forEach(n => { try { n.stop(); n.disconnect(); } catch (e) { } });
        activeNodes = []; 
        activeWaveShapers = []; 
        tracks.forEach(t => { if(t.gainNode) t.gainNode.disconnect(); redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors); });
        pigeonImg.style.transform = "scale(1)"; 
        
        document.querySelectorAll(".pad.queued").forEach(p => p.classList.remove("queued")); 
    });
    
    document.getElementById("undoButton").addEventListener("click", () => { 
        if (undoStack.length > 0) { 
            const stateStr = undoStack.pop(); 
            const state = JSON.parse(stateStr);
            tracks.forEach((t, i) => {
                t.segments = state[i];
                redrawTrack(t, undefined, brushSelect.value, chordIntervals, chordColors);
            });
        } 
    });
    
    document.getElementById("clearButton").addEventListener("click", () => { 
        saveState();
        tracks.forEach(t => { t.segments = []; drawGrid(t); }); 
    });
    
    harmonizeCheckbox.addEventListener("change", () => {
        document.getElementById("scaleSelectContainer").style.display = harmonizeCheckbox.checked ? "inline" : "none";
    });

    document.getElementById("exportButton").addEventListener("click", () => {
        const data = JSON.stringify({ 
            current: { 
                settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: scaleSelect.value, harmonize: harmonizeCheckbox.checked }, 
                fx: { 
                    delay: { time: getKnobVal("DELAY", "TIME") * 1.0, feedback: getKnobVal("DELAY", "FDBK") * 0.9 }, 
                    reverb: { mix: getKnobVal("REVERB", "MIX") * 1.5, decay: getKnobVal("REVERB", "DECAY") * 1.0 }, 
                    vibrato: { rate: getKnobVal("VIBRATO", "RATE") * 20, depth: getKnobVal("VIBRATO", "DEPTH") * 0.01 }, 
                    filter: { freq: getKnobVal("FILTER", "FREQ") * 1.0, res: getKnobVal("FILTER", "RES") * 1.0 }, 
                    stutter: { rate: getKnobVal("STUTTER", "RATE") * 1.0, mix: getKnobVal("STUTTER", "MIX") * 1.0 }, 
                    fractal: { chaos: getKnobVal("FRACTAL", "CHAOS") * 1.0, morph: getKnobVal("FRACTAL", "MORPH") * 1.0 }, 
                    matrix: tracks.map((_, i) => ({ 
                        delay: getMatrixStateByName("DELAY", i), 
                        reverb: getMatrixStateByName("REVERB", i), 
                        vibrato: getMatrixStateByName("VIBRATO", i),
                        filter: getMatrixStateByName("FILTER", i),
                        stutter: getMatrixStateByName("STUTTER", i)
                    })) 
                }, 
                tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) 
            }, 
            banks: patternBanks 
        });
        const blob = new Blob([data], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pigeon_set.json"; a.click();
    });
    
    document.getElementById("importButton").addEventListener("click", () => document.getElementById("importFileInput").click());
    
    document.getElementById("importFileInput").addEventListener("change", e => { 
        const file = e.target.files[0];
        if(!file) return;
        const r = new FileReader(); 
        r.onload = evt => { 
            try {
                const d = JSON.parse(evt.target.result); 
                if (d.banks) { patternBanks = d.banks; updatePadUI(patternBanks); } 
                loadPatternData(d.current || d); 
            } catch(err) { console.error("Fehler beim Laden des Sets:", err); }
        }; 
        r.readAsText(file); 
        e.target.value = ''; 
    });
}

function setupPads() {
    document.getElementById("saveModeBtn").addEventListener("click", (e) => { isSaveMode = !isSaveMode; e.currentTarget.classList.toggle("active", isSaveMode); });
    document.querySelectorAll(".pad").forEach(pad => {
        pad.addEventListener("click", () => {
            const b = pad.dataset.bank, i = parseInt(pad.dataset.idx);
            if (isSaveMode) {
                patternBanks[b][i] = { 
                    settings: { bpm: document.getElementById("bpmInput").value, loop: document.getElementById("loopCheckbox").checked, scale: scaleSelect.value, harmonize: harmonizeCheckbox.checked }, 
                    fx: { 
                        delay: { time: getKnobVal("DELAY", "TIME") * 1.0, feedback: getKnobVal("DELAY", "FDBK") * 0.9 }, 
                        reverb: { mix: getKnobVal("REVERB", "MIX") * 1.5, decay: getKnobVal("REVERB", "DECAY") * 1.0 }, 
                        vibrato: { rate: getKnobVal("VIBRATO", "RATE") * 20, depth: getKnobVal("VIBRATO", "DEPTH") * 0.01 }, 
                        filter: { freq: getKnobVal("FILTER", "FREQ") * 1.0, res: getKnobVal("FILTER", "RES") * 1.0 }, 
                        stutter: { rate: getKnobVal("STUTTER", "RATE") * 1.0, mix: getKnobVal("STUTTER", "MIX") * 1.0 }, 
                        fractal: { chaos: getKnobVal("FRACTAL", "CHAOS") * 1.0, morph: getKnobVal("FRACTAL", "MORPH") * 1.0 }, 
                        matrix: tracks.map((_, trackIdx) => ({ 
                            delay: getMatrixStateByName("DELAY", trackIdx), 
                            reverb: getMatrixStateByName("REVERB", trackIdx), 
                            vibrato: getMatrixStateByName("VIBRATO", trackIdx),
                            filter: getMatrixStateByName("FILTER", trackIdx),
                            stutter: getMatrixStateByName("STUTTER", trackIdx)
                        })) 
                    },
                    tracks: tracks.map(t => ({ segments: t.segments, vol: t.vol, mute: t.mute, wave: t.wave, snap: t.snap })) 
                };
                localStorage.setItem("pigeonBanks", JSON.stringify(patternBanks)); 
                isSaveMode = false; 
                document.getElementById("saveModeBtn").classList.remove("active"); 
                updatePadUI(patternBanks);
                
                document.querySelectorAll(".pad.active").forEach(p => p.classList.remove("active"));
                pad.classList.add("active");
                
            } else if (patternBanks[b] && patternBanks[b][i]) {
                if (isPlaying) { 
                    queuedPattern = { data: patternBanks[b][i], pad: pad }; 
                    document.querySelectorAll(".pad.queued").forEach(p => p.classList.remove("queued")); 
                    pad.classList.add("queued"); 
                }
                else { 
                    loadPatternData(patternBanks[b][i]); 
                    document.querySelectorAll(".pad.active").forEach(p => p.classList.remove("active")); 
                    pad.classList.add("active"); 
                }
            }
        });
    });
}

function getLinkedFX() {
    const links = document.querySelectorAll('.fx-xy-link.active');
    let linked = [];
    links.forEach(l => {
        const header = l.closest('.fx-unit').querySelector('.fx-header');
        if (header) {
            const title = header.textContent.toUpperCase();
            if(title.includes("DELAY")) linked.push("delay");
            if(title.includes("REVERB")) linked.push("reverb");
            if(title.includes("VIBRATO")) linked.push("vibrato");
            if(title.includes("FILTER")) linked.push("filter");
            if(title.includes("STUTTER")) linked.push("stutter");
            if(title.includes("FRACTAL")) linked.push("fractal");
        }
    });
    return linked;
}

function setupTracePad() {
    const crosshair = document.getElementById("trace-crosshair");
    const chH = crosshair ? crosshair.querySelector(".ch-h") : null;
    const chV = crosshair ? crosshair.querySelector(".ch-v") : null;

    const getPadPos = (e) => { 
        const r = tracePad.getBoundingClientRect(); 
        const cx = e.touches ? e.touches[0].clientX : e.clientX; 
        const cy = e.touches ? e.touches[0].clientY : e.clientY; 
        
        if (chH && chV) {
            const visualX = cx - r.left;
            const visualY = cy - r.top;
            if (visualX >= 0 && visualX <= r.width && visualY >= 0 && visualY <= r.height) {
                chV.style.left = visualX + "px";
                chH.style.top = visualY + "px";
            }
        }
        
        return { x: (cx - r.left) * (750 / r.width), y: (cy - r.top) * (100 / r.height) }; 
    };
    
    tracePad.addEventListener("mouseenter", () => { if(crosshair) crosshair.style.display = "block"; });
    tracePad.addEventListener("mouseleave", () => { if(crosshair) crosshair.style.display = "none"; });

    tracePad.addEventListener("mousedown", e => {
        e.preventDefault(); if (!isPlaying) return; initAudio(tracks, updateRoutingFromUI); isTracing = true; const pos = getPadPos(e); traceCurrentY = pos.y;
        
        saveState(); 
        isEffectMode = document.querySelectorAll('.fx-xy-link.active').length > 0;
        
        if (!isEffectMode) { 
            const elapsed = audioCtx.currentTime - playbackStartTime;
            const currentX = (elapsed / playbackDuration) * 750; 
            
            const rX = Math.random() - 0.5;
            const rY = Math.random() - 0.5;

            traceCurrentSeg = { points: [{ x: currentX, y: traceCurrentY, rX, rY }], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value }; 
            tracks[currentTargetTrack].segments.push(traceCurrentSeg); 
            if (brushSelect.value === "particles") triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY); 
            else startLiveSynth(tracks[currentTargetTrack], currentX, traceCurrentY); 
        } else {
            traceCurrentSeg = null; 
        }
    });
    
    tracePad.addEventListener("mousemove", e => { 
        if(crosshair && !e.touches) getPadPos(e); 
        if (isTracing) { 
            const pos = getPadPos(e); 
            traceCurrentY = pos.y; 
            if (!isEffectMode) { 
                if (brushSelect.value !== "particles") {
                    updateLiveSynth(tracks[currentTargetTrack], pos.x, traceCurrentY); 
                }
            } 
        } 
    });
    
    window.addEventListener("mouseup", () => { 
        if (isTracing) { 
            if (!isEffectMode) stopLiveSynth(); 
            isTracing = false; 
            redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); 
        } 
    });
    
    tracePad.addEventListener("touchstart", (e) => { if(crosshair) crosshair.style.display = "block"; }, {passive: false});
    tracePad.addEventListener("touchend", (e) => { if(crosshair) crosshair.style.display = "none"; });

    document.querySelectorAll(".picker-btn").forEach(btn => btn.addEventListener("click", () => { document.querySelectorAll(".picker-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); currentTargetTrack = parseInt(btn.dataset.target); }));
    
    document.getElementById("traceClearBtn").addEventListener("click", () => { 
        saveState();
        tracks[currentTargetTrack].segments = []; 
        redrawTrack(tracks[currentTargetTrack], undefined, brushSelect.value, chordIntervals, chordColors); 
    });
}

function setupFX() {
    document.querySelectorAll('.knob').forEach(knob => {
        setupKnob(knob, (val) => {
            if (!audioCtx) return; 
            const unit = knob.closest('.fx-unit');
            const header = unit.querySelector('.fx-header');
            if (!header || !knob.nextElementSibling) return;
            
            const title = header.textContent.toUpperCase();
            const param = knob.nextElementSibling.textContent.trim();
            
            if (title.includes("DELAY")) { 
                if (param === "TIME") fxNodes.delay.node.delayTime.setTargetAtTime(val * 1.0, audioCtx.currentTime, 0.05); 
                if (param === "FDBK") fxNodes.delay.feedback.gain.setTargetAtTime(val * 0.9, audioCtx.currentTime, 0.05); 
            }
            else if (title.includes("REVERB")) {
                if (param === "MIX") fxNodes.reverb.mix.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
                if (param === "DECAY") updateReverbDecay(val); 
            }
            else if (title.includes("VIBRATO")) { 
                if (param === "RATE") fxNodes.vibrato.lfo.frequency.setTargetAtTime(val * 20, audioCtx.currentTime, 0.05); 
                if (param === "DEPTH") fxNodes.vibrato.depthNode.gain.setTargetAtTime(val * 0.01, audioCtx.currentTime, 0.05); 
            }
            else if (title.includes("FILTER") && fxNodes.filter && fxNodes.filter.node1) {
                if (param === "FREQ") {
                    const cutoff = Math.pow(val, 3) * 22000;
                    fxNodes.filter.node1.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05);
                    fxNodes.filter.node2.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05);
                }
                if (param === "RES") {
                    fxNodes.filter.node1.Q.setTargetAtTime(val * 15, audioCtx.currentTime, 0.05);
                    fxNodes.filter.node2.Q.setTargetAtTime(val * 15, audioCtx.currentTime, 0.05);
                }
            }
            else if (title.includes("STUTTER") && fxNodes.stutter) {
                if (param === "RATE") fxNodes.stutter.lfo.frequency.setTargetAtTime((val * 15) + 1, audioCtx.currentTime, 0.05);
                if (param === "MIX") updateRoutingFromUI();
            }
            else if (title.includes("FRACTAL")) {
                if (param === "MORPH") {
                    const newCurve = getDistortionCurve(80 + (val * 400)); 
                    activeWaveShapers.forEach(sh => sh.curve = newCurve);
                }
                if (param === "CHAOS") {
                    if (audioCtx) {
                        activeNodes.forEach(osc => {
                            if (osc.updateChaos) osc.updateChaos(val);
                        });
                    }
                }
            }
        });
    });
    document.querySelectorAll('.matrix-btn').forEach(btn => btn.addEventListener('click', () => { if (!audioCtx) initAudio(tracks, updateRoutingFromUI); btn.classList.toggle('active'); updateRoutingFromUI(); }));
    document.querySelectorAll('.fx-xy-link').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));
}

function updateRoutingFromUI() {
    if (!audioCtx) return;
    
    const filterActive = [];
    const stutterActive = [];

    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if(!header) return;
        const title = header.textContent.toUpperCase();
        
        let fxName = null;
        if (title.includes("DELAY")) fxName = "delay";
        else if (title.includes("REVERB")) fxName = "reverb";
        else if (title.includes("VIBRATO")) fxName = "vibrato";
        else if (title.includes("FILTER")) fxName = "filter";
        else if (title.includes("STUTTER")) fxName = "stutter";
        
        if (fxName) {
            unit.querySelectorAll('.matrix-btn').forEach((btn, idx) => { 
                const active = btn.classList.contains('active'); 
                if(trackSends[idx] && trackSends[idx][fxName]){
                    if (fxName === "stutter") {
                        stutterActive[idx] = active;
                        trackSends[idx].stutter.gain.setTargetAtTime(active ? getKnobVal("STUTTER", "MIX") : 0, audioCtx.currentTime, 0.05);
                    } else if (fxName === "filter") {
                        filterActive[idx] = active;
                        trackSends[idx].filter.gain.setTargetAtTime(active ? 1 : 0, audioCtx.currentTime, 0.05);
                    } else {
                        trackSends[idx][fxName].gain.setTargetAtTime(active ? 1 : 0, audioCtx.currentTime, 0.05); 
                    }
                }
            });
            const led = unit.querySelector('.led');
            if (led) led.classList.toggle('on', unit.querySelectorAll('.matrix-btn.active').length > 0);
        }
    });

    tracks.forEach((_, idx) => {
        if (trackSends[idx] && trackSends[idx].dry) {
            let dryVol = 1.0;
            if (filterActive[idx]) dryVol = 0.0; 
            else if (stutterActive[idx]) {
                const mix = getKnobVal("STUTTER", "MIX");
                dryVol = 1.0 - mix; 
            }
            trackSends[idx].dry.gain.setTargetAtTime(dryVol, audioCtx.currentTime, 0.05);
        }
    });
}

function loop() {
    if (!isPlaying) return; 
    let elapsed = audioCtx.currentTime - playbackStartTime;
    
    if (elapsed >= playbackDuration) {
        let oldDuration = playbackDuration; 

        if (queuedPattern) { 
            loadPatternData(queuedPattern.data); 
            document.querySelectorAll(".pad").forEach(p => p.classList.remove("active", "queued")); 
            queuedPattern.pad.classList.add("active"); 
            queuedPattern = null; 
        }
        
        if (document.getElementById("loopCheckbox").checked) { 
            playbackStartTime += oldDuration; 
            activeWaveShapers = []; 
            scheduleTracks(playbackStartTime); 
            elapsed = audioCtx.currentTime - playbackStartTime; 
            
            if (isTracing && traceCurrentSeg) { 
                saveState(); 
                traceCurrentSeg = { points: [], brush: brushSelect.value, thickness: parseInt(sizeSlider.value), chordType: chordSelect.value }; 
                tracks[currentTargetTrack].segments.push(traceCurrentSeg); 
            } 
        }
        else { isPlaying = false; return; }
    }
    
    const x = (elapsed / playbackDuration) * 750; 
    
    if (isTracing && !isEffectMode && traceCurrentSeg) { 
        const rX = Math.random() - 0.5;
        const rY = Math.random() - 0.5;
        traceCurrentSeg.points.push({ x, y: traceCurrentY, rX, rY }); 
        
        if (brushSelect.value === "particles") {
            triggerParticleGrain(tracks[currentTargetTrack], traceCurrentY);
        }
    }

    if (isTracing && audioCtx && isEffectMode) {
        const linkedFX = getLinkedFX();
        const normX = x / 750; 
        const normY = 1.0 - (traceCurrentY / 100); 
        linkedFX.forEach(fx => {
            if(fx === "delay" && fxNodes.delay.node) {
                fxNodes.delay.node.delayTime.setTargetAtTime(normX * 1.0, audioCtx.currentTime, 0.05); 
                fxNodes.delay.feedback.gain.setTargetAtTime(normY * 0.9, audioCtx.currentTime, 0.05); 
            }
            if(fx === "vibrato" && fxNodes.vibrato.lfo) {
                fxNodes.vibrato.lfo.frequency.setTargetAtTime(normX * 20, audioCtx.currentTime, 0.05); 
                fxNodes.vibrato.depthNode.gain.setTargetAtTime(normY * 0.01, audioCtx.currentTime, 0.05); 
            }
            if(fx === "reverb" && fxNodes.reverb.mix) {
                fxNodes.reverb.mix.gain.setTargetAtTime(normY * 1.5, audioCtx.currentTime, 0.05); 
                updateReverbDecay(normX);
            }
            if(fx === "filter" && fxNodes.filter && fxNodes.filter.node1) {
                const cutoff = Math.pow(normX, 3) * 22000;
                fxNodes.filter.node1.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05);
                fxNodes.filter.node2.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.05);
                fxNodes.filter.node1.Q.setTargetAtTime(normY * 15, audioCtx.currentTime, 0.05);
                fxNodes.filter.node2.Q.setTargetAtTime(normY * 15, audioCtx.currentTime, 0.05);
            }
            if(fx === "stutter" && fxNodes.stutter) {
                fxNodes.stutter.lfo.frequency.setTargetAtTime((normX * 15) + 1, audioCtx.currentTime, 0.05);
                document.querySelectorAll('.fx-unit').forEach(unit => {
                    const header = unit.querySelector('.fx-header');
                    if (header && header.textContent.toUpperCase().includes("STUTTER")) {
                        const knobs = unit.querySelectorAll('.knob');
                        if(knobs[1]) { knobs[1].dataset.val = normY; knobs[1].style.transform = `rotate(${-135 + (normY * 270)}deg)`; }
                    }
                });
                updateRoutingFromUI();
            }
            if(fx === "fractal") {
                document.querySelectorAll('.fx-unit').forEach(unit => {
                    const header = unit.querySelector('.fx-header');
                    if (header && header.textContent.toUpperCase().includes("FRACTAL")) {
                        const knobs = unit.querySelectorAll('.knob');
                        if(knobs[0]) { knobs[0].dataset.val = normX; knobs[0].style.transform = `rotate(${-135 + (normX * 270)}deg)`; }
                        if(knobs[1]) { 
                            knobs[1].dataset.val = normY; knobs[1].style.transform = `rotate(${-135 + (normY * 270)}deg)`; 
                            const newCurve = getDistortionCurve(80 + (normY * 400));
                            activeWaveShapers.forEach(sh => sh.curve = newCurve);
                        }
                    }
                });
            }
        });
    }
    
    tracks.forEach(t => redrawTrack(t, x, brushSelect.value, chordIntervals, chordColors)); 
    const dataArray = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(dataArray);
    let avg = dataArray.reduce((a, b) => a + b) / dataArray.length; let d = avg - lastAvg; lastAvg = avg;
    
    let scaleX = 1 + Math.min(0.2, d / 100);
    let scaleY = 1 - Math.min(0.5, d / 50);
    
    let isFractalPlaying = false;
    
    if (liveGainNode && brushSelect.value === "fractal") {
        isFractalPlaying = true; 
    }
    
    if (isPlaying) {
        const anySolo = tracks.some(t => t.solo);
        tracks.forEach(track => {
            if (track.mute || (anySolo && !track.solo)) return; 
            track.segments.forEach(seg => {
                if (seg.brush === "fractal" && seg.points.length > 0) {
                    const sorted = seg.points.slice().sort((a, b) => a.x - b.x);
                    const startX = sorted[0].x;
                    const endX = sorted[sorted.length - 1].x;
                    if (x >= startX && x <= endX + 10) {
                        isFractalPlaying = true;
                    }
                }
            });
        });
    }
    
    if (isFractalPlaying) {
        const jitterX = (Math.random() - 0.5) * 15;
        const jitterY = (Math.random() - 0.5) * 15;
        pigeonImg.style.transform = `scale(${scaleX}, ${scaleY}) translate(${jitterX}px, ${jitterY}px)`;
        pigeonImg.style.filter = `
            drop-shadow(${jitterX * 1.5}px ${jitterY * 1.5}px 0 rgba(255, 0, 0, 0.8)) 
            drop-shadow(${-jitterX * 1.5}px ${-jitterY * 1.5}px 0 rgba(0, 255, 255, 0.8))
            hue-rotate(${Math.random() * 360}deg)
            contrast(150%)
        `;
    } else {
        pigeonImg.style.transform = `scale(${scaleX}, ${scaleY}) translate(0px, 0px)`;
        pigeonImg.style.filter = 'none';
    }
}

function setupTrackControls(t) {
    const cont = t.canvas.closest('.track-container'); 
    if(!cont) return;
    
    cont.querySelectorAll(".wave-btn").forEach(b => b.addEventListener("click", () => { 
        t.wave = b.dataset.wave; 
        cont.querySelectorAll(".wave-btn").forEach(btn => btn.classList.remove("active")); 
        b.classList.add("active"); 
    }));
    
    const muteBtn = cont.querySelector(".mute-btn");
    if(muteBtn) {
        muteBtn.addEventListener("click", e => { 
            t.mute = !t.mute; 
            muteBtn.classList.toggle("active", t.mute); 
            applyAllVolumes(); 
        });
    }

    const soloBtn = cont.querySelector(".btn--solo");
    if(soloBtn) {
        soloBtn.addEventListener("click", e => {
            t.solo = !t.solo;
            soloBtn.classList.toggle("active", t.solo);
            applyAllVolumes();
        });
    }

    const volSlider = cont.querySelector(".volume-slider");
    if(volSlider) volSlider.addEventListener("input", e => { 
        t.vol = parseFloat(e.target.value); 
        applyAllVolumes(); 
    });
    
    const snapBox = cont.querySelector(".snap-checkbox");
    if(snapBox) snapBox.addEventListener("change", e => t.snap = e.target.checked);
}

const peakDataArray = new Float32Array(256);
const clippingLEDs = [
    document.getElementById('peak-t1'),
    document.getElementById('peak-t2'),
    document.getElementById('peak-t3'),
    document.getElementById('peak-t4')
];

function updateClippingLEDs() {
    if (!audioCtx || !trackAnalysers || trackAnalysers.length === 0) {
        requestAnimationFrame(updateClippingLEDs);
        return;
    }

    for (let i = 0; i < 4; i++) {
        const analyser = trackAnalysers[i];
        const led = clippingLEDs[i];
        
        if (!analyser || !led) continue;
        
        analyser.getFloatTimeDomainData(peakDataArray);
        
        let maxPeak = 0;
        for (let j = 0; j < peakDataArray.length; j++) {
            const absValue = Math.abs(peakDataArray[j]);
            if (absValue > maxPeak) {
                maxPeak = absValue;
            }
        }

        if (maxPeak >= 0.95) {
            led.classList.add('peak');
            led.classList.remove('warning');
        } else if (maxPeak >= 0.75) {
            led.classList.add('warning');
            led.classList.remove('peak');
        } else {
            led.classList.remove('peak');
            led.classList.remove('warning');
        }
        
        led.style.background = ''; 
    }

    requestAnimationFrame(updateClippingLEDs);
}

updateClippingLEDs();