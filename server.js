// LITESHOT online server: free-for-all rooms, one room per map.
// Run with:  npm install  then  npm start   (listens on PORT, default 3000)
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAPS = ['og', 'mini', 'house'];
const MAX_PER_MAP = 8;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LITESHOT online server is running');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

const players = new Map(); // socket id -> player

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const publicInfo = (p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, health: p.health, dead: p.dead, kills: p.kills, deaths: p.deaths, appearance: p.appearance });

// Keep only the look settings we expect, so a bad client can't send junk to everyone else
const HELMETS = ['visor', 'full', 'scout'];
const ARMORS = ['heavy', 'light', 'none'];
function cleanAppearance(a) {
    const x = a && typeof a === 'object' ? a : {};
    const color = Number.isFinite(x.color) ? x.color : 0x00ffcc;
    const emblem = typeof x.emblem === 'string' && x.emblem.startsWith('data:image/') && x.emblem.length < 60000 ? x.emblem : undefined;
    return {
        color: color,
        visor: Number.isFinite(x.visor) ? x.visor : color,
        helmet: HELMETS.includes(x.helmet) ? x.helmet : 'visor',
        armor: ARMORS.includes(x.armor) ? x.armor : 'heavy',
        emblem: emblem
    };
}

io.on('connection', (socket) => {
    socket.on('join', (data = {}) => {
        const map = MAPS.includes(data.map) ? data.map : 'og';
        const inRoom = [...players.values()].filter((p) => p.map === map);
        if (inRoom.length >= MAX_PER_MAP) {
            socket.emit('full');
            socket.disconnect(true);
            return;
        }
        const player = {
            id: socket.id, name: String(data.name || 'Operative').slice(0, 16), map: map,
            x: 0, y: 0, z: 0, yaw: 0, health: 100, dead: false, kills: 0, deaths: 0,
            appearance: cleanAppearance(data.appearance)
        };
        players.set(socket.id, player);
        socket.join(map);
        socket.emit('roster', inRoom.map(publicInfo));
        socket.to(map).emit('playerJoined', publicInfo(player));
    });

    socket.on('appearance', (a = {}) => {
        const p = players.get(socket.id);
        if (!p) return;
        p.appearance = cleanAppearance(a);
        io.to(p.map).emit('appearance', { id: p.id, appearance: p.appearance });
    });

    socket.on('state', (s = {}) => {
        const p = players.get(socket.id);
        if (!p) return;
        p.x = num(s.x); p.y = num(s.y); p.z = num(s.z); p.yaw = num(s.yaw);
    });

    // a shot landed on another player: tell the victim's game to take the damage
    socket.on('hit', (h = {}) => {
        const me = players.get(socket.id);
        const target = players.get(h.targetId);
        if (!me || !target || target.map !== me.map || target.dead || target.id === me.id) return;
        const amount = Math.max(0, Math.min(200, num(h.amount)));
        target.health = Math.max(0, target.health - amount);
        io.to(target.id).emit('hurt', { amount: amount, from: me.id, weapon: String(h.weapon || 'Unknown').slice(0, 24) });
    });

    // the victim's game reports its own death
    socket.on('died', (d = {}) => {
        const victim = players.get(socket.id);
        if (!victim || victim.dead) return;
        victim.dead = true;
        victim.deaths++;
        const killer = players.get(d.killerId);
        if (killer && killer.map === victim.map && killer.id !== victim.id) killer.kills++;
        io.to(victim.map).emit('kill', {
            killerId: killer ? killer.id : null,
            killer: killer ? killer.name : 'Unknown',
            victimId: victim.id,
            victim: victim.name,
            weapon: String(d.weapon || 'Unknown').slice(0, 24)
        });
    });

    socket.on('respawn', (d = {}) => {
        const p = players.get(socket.id);
        if (!p) return;
        p.dead = false;
        p.health = 100;
        p.x = num(d.x); p.z = num(d.z);
    });

    socket.on('disconnect', () => {
        const p = players.get(socket.id);
        if (!p) return;
        players.delete(socket.id);
        io.to(p.map).emit('playerLeft', p.id);
    });
});

// everyone in a room gets the positions of the others about 20 times a second
setInterval(() => {
    for (const map of MAPS) {
        const list = [...players.values()].filter((p) => p.map === map).map(publicInfo);
        if (list.length) io.to(map).volatile.emit('states', list);
    }
}, 50);

httpServer.listen(PORT, () => console.log(`LITESHOT online server on port ${PORT}`));
