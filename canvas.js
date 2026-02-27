export function drawGrid(t) { 
    t.ctx.save(); t.ctx.clearRect(0,0,t.canvas.width,t.canvas.height); t.ctx.strokeStyle="#eee"; 
    for(let i=0;i<=32;i++){ t.ctx.beginPath(); let x = i*(t.canvas.width/32); t.ctx.moveTo(x,0); t.ctx.lineTo(x,t.canvas.height); t.ctx.lineWidth = (i % 4 === 0) ? 2 : 1; t.ctx.stroke(); } 
    t.ctx.restore(); 
}

// Hilfsfunktionen für die Pinsel-Stile
function drawSegmentStandard(ctx, pts, idx1, idx2, size) { ctx.lineWidth = size; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentVariable(ctx, pts, idx1, idx2, size) { const dist = Math.hypot(pts[idx2].x - pts[idx1].x, pts[idx2].y - pts[idx1].y); ctx.lineWidth = size * (1 + Math.max(0, (10 - dist) / 5)); ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(pts[idx1].x, pts[idx1].y); ctx.lineTo(pts[idx2].x, pts[idx2].y); ctx.stroke(); }
function drawSegmentCalligraphy(ctx, pts, idx1, idx2, size) { const angle = -Math.PI / 4, dx = Math.cos(angle) * size, dy = Math.sin(angle) * size; ctx.fillStyle = "#000"; ctx.beginPath(); ctx.moveTo(pts[idx1].x - dx, pts[idx1].y - dy); ctx.lineTo(pts[idx1].x + dx, pts[idx1].y + dy); ctx.lineTo(pts[idx2].x + dx, pts[idx2].y + dy); ctx.lineTo(pts[idx2].x - dx, pts[idx2].y - dy); ctx.fill(); }

function drawSegmentParticles(ctx, pts, idx1, idx2, size) { 
    ctx.fillStyle = "rgba(0,0,0,0.6)"; 
    for(let i=0; i<2; i++) { 
        const ox = (Math.random()-0.5)*size*2, oy = (Math.random()-0.5)*size*2; 
        ctx.beginPath(); 
        ctx.arc(pts[idx2].x+ox, pts[idx2].y+oy, Math.max(1, size/3), 0, Math.PI*2); 
        ctx.fill(); 
    } 
}

// ECHTES VISUELLES MORPHING: Die Linie verzerrt sich geometrisch!
function drawSegmentFractal(ctx, pts, idx1, idx2, size, liveChaos, liveMorph) { 
    // 1. Die Chaos-Berechnung (wie stark die Punkte selbst schwanken)
    const jx1 = (pts[idx1].rX||0) * 50 * liveChaos; const jy1 = (pts[idx1].rY||0) * 100 * liveChaos;
    const jx2 = (pts[idx2].rX||0) * 50 * liveChaos; const jy2 = (pts[idx2].rY||0) * 100 * liveChaos;
    
    const x1 = pts[idx1].x + jx1; const y1 = pts[idx1].y + jy1;
    const x2 = pts[idx2].x + jx2; const y2 = pts[idx2].y + jy2;

    ctx.lineCap = liveMorph > 0.5 ? "square" : "round"; 
    
    if (liveMorph > 0.05) {
        // Normalenvektor berechnen (Vektor senkrecht zur Zeichenrichtung)
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len; 
        const ny = dx / len;
        
        // Wie stark schlägt die Verzerrung aus?
        const distAmount = liveMorph * size * 1.5;
        
        // Abwechselnder Ausschlag für den "Square-Wave/Sägezahn" Effekt
        const side1 = (idx1 % 2 === 0) ? 1 : -1;
        const side2 = (idx2 % 2 === 0) ? 1 : -1;

        ctx.strokeStyle = "#000";

        // Die gezackte Verzerrungslinie (Distortion Fuzz)
        ctx.lineWidth = size * (1 - liveMorph * 0.3);
        ctx.beginPath();
        ctx.moveTo(x1 + nx * distAmount * side1, y1 + ny * distAmount * side1);
        ctx.lineTo(x2 + nx * distAmount * side2, y2 + ny * distAmount * side2);
        ctx.stroke();
        
        // Dünner, solider Kern in der Mitte
        ctx.lineWidth = Math.max(1, size * 0.2);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

    } else {
        // Normaler Fraktal-Pinsel ohne Morph
        ctx.lineWidth = size; 
        ctx.strokeStyle = "#000";
        ctx.beginPath(); 
        ctx.moveTo(x1, y1); 
        ctx.lineTo(x2, y2); 
        ctx.stroke(); 
    }
}

export function redrawTrack(t, hx, brushSelectValue, chordIntervals, chordColors) {
    drawGrid(t);
    
    // Live-Chaos und Live-Morph abgreifen
    let liveChaos = 0;
    let liveMorph = 0;
    
    document.querySelectorAll('.fx-unit').forEach(unit => {
        const header = unit.querySelector('.fx-header');
        if (header && header.textContent.toUpperCase().includes("FRACTAL")) {
            unit.querySelectorAll('.knob').forEach(k => {
                const paramName = k.nextElementSibling ? k.nextElementSibling.textContent.trim() : "";
                if (paramName === "CHAOS") {
                    liveChaos = parseFloat(k.dataset.val || 0);
                }
                if (paramName === "MORPH") {
                    liveMorph = parseFloat(k.dataset.val || 0);
                }
            });
        }
    });

    t.segments.forEach(seg => {
        const pts = seg.points; if (pts.length < 1) return;
        const brush = seg.brush || "standard"; const size = seg.thickness || 5;
        t.ctx.beginPath(); t.ctx.strokeStyle = "#000"; t.ctx.lineWidth = size;
        
        if(brush === "chord"){ 
            chordIntervals[seg.chordType||"major"].forEach((iv,i) => { 
                t.ctx.save(); t.ctx.beginPath(); t.ctx.strokeStyle = chordColors[i%3]; t.ctx.lineWidth = size; 
                t.ctx.moveTo(pts[0].x, pts[0].y-iv*5); for(let k=1;k<pts.length;k++) t.ctx.lineTo(pts[k].x,pts[k].y-iv*5); 
                t.ctx.stroke(); t.ctx.restore(); 
            }); 
        } else if(brush === "particles"){ 
            for(let i=1;i<pts.length;i++) drawSegmentParticles(t.ctx, pts, i-1, i, size); 
        } else { 
            for(let i=1;i<pts.length;i++){ 
                switch(brush){ 
                    case "variable": drawSegmentVariable(t.ctx, pts, i-1, i, size); break; 
                    case "calligraphy": drawSegmentCalligraphy(t.ctx, pts, i-1, i, size); break; 
                    case "fractal": drawSegmentFractal(t.ctx, pts, i-1, i, size, liveChaos, liveMorph); break; 			
                    case "xenakis": drawSegmentXenakis(t.ctx, pts, i-1, i, size); break;
                    default: drawSegmentStandard(t.ctx, pts, i-1, i, size); 
                } 
            }
        } 
    });
    
    if(hx !== undefined){ 
        t.ctx.save(); t.ctx.beginPath(); t.ctx.strokeStyle = "red"; t.ctx.lineWidth = 2; 
        t.ctx.moveTo(hx,0); t.ctx.lineTo(hx,100); t.ctx.stroke(); t.ctx.restore(); 
    }
}

function drawSegmentXenakis(ctx, pts, idx1, idx2, size) { 
    ctx.lineCap = "round"; 
    ctx.strokeStyle = "rgba(0, 0, 0, 0.4)"; 
    for (let i = -2; i <= 2; i++) { 
        ctx.lineWidth = Math.max(1, size / 3); 
        ctx.beginPath(); 
        const wave1 = Math.sin(pts[idx1].x * 0.04 + i * 1.5) * size * 1.5; 
        const wave2 = Math.sin(pts[idx2].x * 0.04 + i * 1.5) * size * 1.5; 
        ctx.moveTo(pts[idx1].x, pts[idx1].y + wave1 + (i * size * 0.5)); 
        ctx.lineTo(pts[idx2].x, pts[idx2].y + wave2 + (i * size * 0.5)); 
        ctx.stroke(); 
    } 
    ctx.strokeStyle = "#000"; 
}