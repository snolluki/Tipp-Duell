const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;

// Altersgerechte Texte für die 5. Klasse mit gängigen Sonderzeichen (Satzzeichen, Anführungszeichen, Zahlen)
const TEXTS = [
    "Ein kleiner Drache flog durch die kühlen Wolken. Er rief fröhlich: „Heute ist ein toller Tag für Abenteuer!“",
    "Im dichten Wald entdeckten die Kinder eine alte Hütte. Lisa wunderte sich: „Wer wohnt wohl hier im Forst?“",
    "Der blitzschnelle Roboter drehte sich dreimal im Kreis und blinkte bunt. „System ist bereit!“, piepste er laut.",
    "Auf der bunten Blumenwiese summten viele Bienen. Sie sammelten süßen Honig für ihren großen Bienenstock.",
    "Der alte Zauberer öffnete sein dickes Zauberbuch. Mit tiefer Stimme sprach er: „Hokus Pokus, 1, 2, 3 – Zauberei!“",
    "Am blauen Himmel standen weiße Wolken. Paul fragte schmunzelnd: „Sieht diese Wolke nicht aus wie ein Elefant?“",
    "In der großen Pause spielten alle Kinder begeistert Fußball. Das Match endete 3:2 – was für ein spannendes Spiel!"
];

// Speicher für aktive Räume und SSE-Verbindungen
const rooms = {};
const roomClients = {};

function generateRoomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function broadcastRoomState(roomCode) {
    if (!rooms[roomCode] || !roomClients[roomCode]) return;
    const data = `data: ${JSON.stringify(rooms[roomCode])}\n\n`;
    roomClients[roomCode].forEach(client => client.res.write(data));
}

const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    
    // Server-Sent Events (SSE) für Echtzeit-Sync
    if (urlObj.pathname === '/events') {
        const roomCode = urlObj.searchParams.get('room');
        const token = urlObj.searchParams.get('token');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        if (!roomClients[roomCode]) roomClients[roomCode] = [];
        roomClients[roomCode].push({ res, token });

        if (rooms[roomCode]) {
            res.write(`data: ${JSON.stringify(rooms[roomCode])}\n\n`);
        }

        req.on('close', () => {
            if (roomClients[roomCode]) {
                roomClients[roomCode] = roomClients[roomCode].filter(c => c.res !== res);
            }
        });
        return;
    }

    // API für Spiel-Aktionen
    if (urlObj.pathname === '/action' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const action = JSON.parse(body);
                handleAction(action, res);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Ungültige Anfrage' }));
            }
        });
        return;
    }

    // Statische index.html ausliefern
    let filePath = urlObj.pathname === '/' || urlObj.pathname === '/index.html' ? 'index.html' : urlObj.pathname;
    filePath = path.basename(filePath);
    fs.readFile(path.join(__dirname, filePath), (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Nicht gefunden');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        }
    });
});

function handleAction(action, res) {
    const { type, token, payload } = action;

    switch (type) {
        case 'CREATE_ROOM': {
            const code = generateRoomCode();
            const selectedText = TEXTS[Math.floor(Math.random() * TEXTS.length)];
            
            rooms[code] = {
                code,
                text: selectedText,
                status: 'waiting', // waiting, countdown, playing, finished
                countdown: 3,
                winnerToken: null,
                players: [
                    {
                        token,
                        name: payload.name || 'Spieler 1',
                        progress: 0,
                        typedLength: 0,
                        errors: 0,
                        cpm: 0,
                        finished: false,
                        isHost: true
                    }
                ]
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, roomCode: code }));
            break;
        }

        case 'JOIN_ROOM': {
            const code = payload.roomCode;
            const room = rooms[code];

            if (!room) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Raum nicht gefunden!' }));
                return;
            }

            if (room.players.length >= 2 && !room.players.some(p => p.token === token)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Raum ist bereits voll!' }));
                return;
            }

            // Spieler hinzufügen falls neu
            if (!room.players.some(p => p.token === token)) {
                room.players.push({
                    token,
                    name: payload.name || 'Spieler 2',
                    progress: 0,
                    typedLength: 0,
                    errors: 0,
                    cpm: 0,
                    finished: false,
                    isHost: false
                });
            }

            // Sobald 2 Spieler im Raum sind, Countdown starten
            if (room.players.length === 2 && room.status === 'waiting') {
                room.status = 'countdown';
                room.countdown = 3;
                
                const timer = setInterval(() => {
                    room.countdown--;
                    if (room.countdown <= 0) {
                        clearInterval(timer);
                        room.status = 'playing';
                        room.startTime = Date.now();
                    }
                    broadcastRoomState(code);
                }, 1000);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, roomCode: code }));
            broadcastRoomState(code);
            break;
        }

        case 'UPDATE_PROGRESS': {
            const room = rooms[payload.roomCode];
            if (!room || room.status !== 'playing') {
                res.writeHead(200);
                res.end(JSON.stringify({ success: false }));
                return;
            }

            const player = room.players.find(p => p.token === token);
            if (player && !player.finished) {
                player.progress = payload.progress;
                player.typedLength = payload.typedLength;
                player.errors = payload.errors;
                player.cpm = payload.cpm;

                // Ziel erreicht?
                if (payload.progress >= 100) {
                    player.finished = true;
                    if (!room.winnerToken) {
                        room.winnerToken = token;
                        room.status = 'finished';
                    }
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            broadcastRoomState(payload.roomCode);
            break;
        }

        case 'RESTART_GAME': {
            const room = rooms[payload.roomCode];
            if (room) {
                room.text = TEXTS[Math.floor(Math.random() * TEXTS.length)];
                room.status = 'countdown';
                room.countdown = 3;
                room.winnerToken = null;
                room.players.forEach(p => {
                    p.progress = 0;
                    p.typedLength = 0;
                    p.errors = 0;
                    p.cpm = 0;
                    p.finished = false;
                });

                const timer = setInterval(() => {
                    room.countdown--;
                    if (room.countdown <= 0) {
                        clearInterval(timer);
                        room.status = 'playing';
                        room.startTime = Date.now();
                    }
                    broadcastRoomState(payload.roomCode);
                }, 1000);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            broadcastRoomState(payload.roomCode);
            break;
        }

        default:
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Unbekannte Aktion' }));
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tipp-Duell Server aktiv auf Port ${PORT}`);
});