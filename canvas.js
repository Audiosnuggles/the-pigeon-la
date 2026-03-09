export function drawGrid(t) { 
    t.ctx.save(); t.ctx.clearRect(0,0,t.canvas.width,t.canvas.height); t.ctx.strokeStyle="#eee"; 
    for(let i=0;i<=32;i++){ t.ctx.beginPath(); let x = i*(t.canvas.width/32); t.ctx.moveTo(x,0); t.ctx.lineTo(x,t.canvas.height); t.ctx.lineWidth = (i % 4 === 0) ? 2 : 1; t.ctx.stroke(); } 
    t.ctx.restore(); 
}

// Hilfsfunktionen für komplexe Pinsel (die noch segmentweise berechnet werden müssen)
function drawSegmentVariable(ctx, pts, idx1, idx2, size) { const dist = Math.hypot(pts[idx2].x - pts[idx1].x, pts[idx2].y - pts[idx1].y); ctx.lineWidth = size * (1 + Math.max(0, (10 - dist) / 5)); ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentCalligraphy(ctx, pts, idx1, idx2, size) { const angle = -Math.PI / 4, dx = Math.cos(angle) * size, dy = Math.sin(angle) * size; ctx.fillStyle = "#000"; ctx.beginPath(); ctx.moveTo(pts[idx1].x - dx, pts[idx1].y - dy); ctx.lineTo(pts[idx1].x + dx, pts[idx1].y + dy); ctx.lineTo(pts[idx2].x + dx, pts[idx2].y + dy); ctx.lineTo(pts[idx2].x - dx, pts[idx2].y - dy); ctx.fill(); }
function drawSegmentParticles(ctx, pts, idx1, idx2, size) { ctx.fillStyle = "rgba(0,0,0,0.6)"; for(let i=0; i<2; i++) { const ox = (Math.random()-0.5)*size*2, oy = (Math.random()-0.5)*size*2; ctx.beginPath(); ctx.arc(pts[idx2].x+ox, pts[idx2].y+oy, Math.max(1, size/3), 0, Math.PI*2); ctx.fill(); } }
function drawSegmentFractal(ctx, pts, idx1, idx2, size, liveChaos, liveMorph) { ctx.lineCap = liveMorph > 0.5 ? "square" : "round"; ctx.lineWidth = size; ctx.strokeStyle = "#000"; ctx.beginPath(); const jx1 = (pts[idx1].rX||0) * 50 * liveChaos; const jy1 = (pts[idx1].rY||0) * 100 * liveChaos; const jx2 = (pts[idx2].rX||0) * 50 * liveChaos; const jy2 = (pts[idx2].rY||0) * 100 * liveChaos; ctx.moveTo(pts[idx1].x + jx1, pts[idx1].y + jy1); ctx.lineTo(pts[idx2].x + jx2, pts[idx2].y + jy2); ctx.stroke(); if (liveMorph > 0) { ctx.lineWidth = Math.max(1, size * (liveMorph * 1.5)); ctx.strokeStyle = `rgba(255, 68, 68, ${liveMorph * 0.7})`; ctx.beginPath(); ctx.moveTo(pts[idx1].x + jx1 * (1 + liveMorph), pts[idx1].y + jy1 * (1 + liveMorph)); ctx.lineTo(pts[idx2].x + jx2 * (1 + liveMorph), pts[idx2].y + jy2 * (1 + liveMorph)); ctx.stroke(); } }
function drawSegmentXenakis(ctx, pts, idx1, idx2, size) { ctx.strokeStyle = "rgba(0, 0, 0, 0.4)"; for (let i = -2; i <= 2; i++) { ctx.lineWidth = Math.max(1, size / 3); ctx.beginPath(); const wave1 = Math.sin(pts[idx1].x * 0.04 + i * 1.5) * size * 1.5; const wave2 = Math.sin(pts[idx2].x * 0.04 + i * 1.5) * size * 1.5; ctx.moveTo(pts[idx1].x, pts[idx1].y + wave1 + (i * size * 0.5)); ctx.lineTo(pts[idx2].x, pts[idx2].y + wave2 + (i * size * 0.5)); ctx.stroke(); } ctx.strokeStyle = "#000"; }
function drawSegmentFM(ctx, pts, idx1, idx2, size) { ctx.lineWidth = size * 2.5; ctx.strokeStyle = "rgba(0, 150, 255, 0.2)"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); ctx.lineWidth = Math.max(1, size / 2); ctx.strokeStyle = "#000"; ctx.beginPath(); const side1 = (idx1 % 2 === 0) ? 1 : -1; const side2 = (idx2 % 2 === 0) ? 1 : -1; const fmSpread = size * 1.2; ctx.moveTo(pts[idx1].x, pts[idx1].y + fmSpread * side1); ctx.lineTo(pts[idx2].x, pts[idx2].y + fmSpread * side2); ctx.stroke(); }

export function redrawTrack(t, hx, brushSelectValue, chordIntervals, chordColors) {
    drawGrid(t);
    
    let liveChaos = 0;
    let liveMorph = 0;
    
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes("FRACTAL")) {
            unit.querySelectorAll('.knob').forEach(k => {
                const paramName = k.nextElementSibling ? k.nextElementSibling.textContent.trim() : "";
                if (paramName === "CHAOS") { liveChaos = parseFloat(k.dataset.val || 0); }
                if (paramName === "MORPH") { liveMorph = parseFloat(k.dataset.val || 0); }
            });
        }
    });

    t.segments.forEach(seg => {
        const pts = seg.points; if (pts.length < 1) return;
        const brush = seg.brush || "standard"; const size = seg.thickness || 5;
        
        t.ctx.save(); 
        
        // Glow-Effekt für selektierte Linien
        if (t.selectedSegments && t.selectedSegments.includes(seg)) {
            t.ctx.shadowColor = "#0275ff";
            t.ctx.shadowBlur = 8;
        }

        // Globale Settings für weiche Joints
        t.ctx.lineJoin = "round";
        t.ctx.lineCap = "round";
        t.ctx.strokeStyle = "#000"; 
        t.ctx.lineWidth = size;
        
        // Zeichne durchgehende Pfade (Continuous Paths) anstatt Stückwerk!
        if (brush === "standard") {
            t.ctx.beginPath();
            t.ctx.moveTo(pts[0].x, pts[0].y);
            for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, pts[i].y);
            t.ctx.stroke();
            
        } else if (brush === "rorschach") {
            t.ctx.beginPath();
            t.ctx.moveTo(pts[0].x, pts[0].y);
            for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, pts[i].y);
            t.ctx.stroke();
            
            t.ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
            t.ctx.beginPath();
            t.ctx.moveTo(pts[0].x, 100 - pts[0].y);
            for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, 100 - pts[i].y);
            t.ctx.stroke();
            
        } else if (brush === "overtone") {
            for (let j = 1; j <= 5; j++) {
                t.ctx.lineWidth = size / j; 
                t.ctx.strokeStyle = `rgba(0, 0, 0, ${1 / j})`; 
                t.ctx.beginPath();
                const offset = Math.log2(j) * 20; 
                t.ctx.moveTo(pts[0].x, pts[0].y - offset);
                for(let i=1; i<pts.length; i++) t.ctx.lineTo(pts[i].x, pts[i].y - offset);
                t.ctx.stroke();
            }
            
        } else if (brush === "chord") { 
            const ivs = chordIntervals[seg.chordType || "major"] || chordIntervals["major"];
            ivs.forEach((iv,i) => { 
                t.ctx.save(); 
                t.ctx.beginPath(); 
                t.ctx.strokeStyle = chordColors ? chordColors[i%3] : '#000'; 
                t.ctx.lineWidth = size; 
                t.ctx.moveTo(pts[0].x, pts[0].y-iv*5); 
                for(let k=1;k<pts.length;k++) t.ctx.lineTo(pts[k].x,pts[k].y-iv*5); 
                t.ctx.stroke(); 
                t.ctx.restore(); 
            }); 
            
        } else if (brush === "particles") { 
            for(let i=1;i<pts.length;i++) drawSegmentParticles(t.ctx, pts, i-1, i, size); 
        } else { 
            // Komplexe Brushes, die zwingend segmentweise gezeichnet werden müssen
            for(let i=1;i<pts.length;i++){ 
                switch(brush){ 
                    case "variable": drawSegmentVariable(t.ctx, pts, i-1, i, size); break; 
                    case "calligraphy": drawSegmentCalligraphy(t.ctx, pts, i-1, i, size); break; 
                    case "fractal": drawSegmentFractal(t.ctx, pts, i-1, i, size, liveChaos, liveMorph); break; 			
                    case "xenakis": drawSegmentXenakis(t.ctx, pts, i-1, i, size); break;
                    case "fm": drawSegmentFM(t.ctx, pts, i-1, i, size); break;
                } 
            }
        } 
        
        t.ctx.restore(); 
    });
    
    // Auswahl-Rechteck (Marquee) zeichnen
    if (t.selectionBox) {
        t.ctx.fillStyle = "rgba(0, 150, 255, 0.2)";
        t.ctx.strokeStyle = "rgba(0, 150, 255, 0.8)";
        t.ctx.lineWidth = 1;
        t.ctx.fillRect(t.selectionBox.x, t.selectionBox.y, t.selectionBox.w, t.selectionBox.h);
        t.ctx.strokeRect(t.selectionBox.x, t.selectionBox.y, t.selectionBox.w, t.selectionBox.h);
    }

    if(hx !== undefined){ 
        t.ctx.save(); 
        
        // Klare, saubere Playback-Linie (wissenschaftlicher Look)
        t.ctx.beginPath(); 
        t.ctx.strokeStyle = "rgba(255, 68, 68, 0.8)"; 
        t.ctx.lineWidth = 1; 
        t.ctx.moveTo(hx, 0); 
        t.ctx.lineTo(hx, t.canvas.height); 
        t.ctx.stroke(); 
        
        // --- SCAN EFFEKT (Smarte, CPU-schonende Kontaktpunkte) ---
        t.segments.forEach(seg => {
            const pts = seg.points;
            if (!pts || pts.length === 0) return;

            // Bounding Box Check: Ignoriere die Linie sofort, wenn der Scanner weit weg ist!
            let minX = pts[0].x, maxX = pts[0].x;
            for (let p of pts) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
            }
            if (hx < minX - 10 || hx > maxX + 10) return;

            const size = seg.thickness || 5;

            // Hilfsfunktion: Zeichnet den exakten Hit-Point
            const drawPing = (yPos) => {
                t.ctx.beginPath();
                t.ctx.arc(hx, yPos, 2.5, 0, Math.PI * 2);
                t.ctx.fillStyle = "#ffffff";
                t.ctx.lineWidth = 1.5;
                t.ctx.strokeStyle = "#ff4444";
                t.ctx.fill();
                t.ctx.stroke();
            };

            // Smartes Abtasten je nach Pinselart (berechnet FM, Xenakis, Fractal etc. mit)
            const drawAllPings = (baseY, actualX, rY_val = 0) => {
                let brush = seg.brush || "standard";
                if (brush === "rorschach") {
                    drawPing(baseY); drawPing(100 - baseY);
                } else if (brush === "chord") {
                    const ivs = chordIntervals[seg.chordType || "major"] || chordIntervals["major"];
                    ivs.forEach(iv => { if (iv !== 0) drawPing(baseY - iv * 5); });
                    drawPing(baseY);
                } else if (brush === "overtone") {
                    drawPing(baseY);
                    for (let j = 2; j <= 5; j++) drawPing(baseY - Math.log2(j) * 20);
                } else if (brush === "xenakis") {
                    for (let j = -2; j <= 2; j++) {
                        const wave = Math.sin(actualX * 0.04 + j * 1.5) * size * 1.5;
                        drawPing(baseY + wave + (j * size * 0.5));
                    }
                } else if (brush === "fm") {
                    const fmSpread = size * 1.2;
                    drawPing(baseY + fmSpread); drawPing(baseY - fmSpread);
                } else if (brush === "fractal") {
                    let chaosOffset = rY_val * 100 * liveChaos;
                    drawPing(baseY + chaosOffset);
                } else {
                    drawPing(baseY);
                }
            };

            // Berührung auswerten
            if (pts.length === 1) {
                if (Math.abs(hx - pts[0].x) <= 2.5) { 
                    drawAllPings(pts[0].y, pts[0].x, pts[0].rY);
                }
            } else {
                for (let i = 0; i < pts.length - 1; i++) {
                    let p1 = pts[i]; let p2 = pts[i+1];
                    let leftP = p1.x < p2.x ? p1 : p2;
                    let rightP = p1.x < p2.x ? p2 : p1;

                    // Toleranz auf X erweitert, damit senkrechte Striche gefunden werden
                    if (hx >= leftP.x - 1.5 && hx <= rightP.x + 1.5) {
                        let ratio = 0;
                        if (rightP.x - leftP.x > 0.01) {
                            ratio = (hx - leftP.x) / (rightP.x - leftP.x);
                            ratio = Math.max(0, Math.min(1, ratio)); 
                        }
                        let intersectY = leftP.y + ratio * (rightP.y - leftP.y);
                        let interpolated_rY = (leftP.rY || 0) + ratio * ((rightP.rY || 0) - (leftP.rY || 0));

                        drawAllPings(intersectY, hx, interpolated_rY);
                    }
                }
            }
        });

        t.ctx.restore(); 
    }
}