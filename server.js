// LITESHOT online server.
//  - Free-for-all: one room per map (og, mini, house), up to 8 players.
//  - Figure: one room per map, prefixed "fig-". One player is the Figure, the rest are survivors.
// Run with:  npm install  then  npm start   (listens on PORT, default 3000)
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAPS = ['og', 'mini', 'house'];
const MAX_PER_ROOM = 8;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LITESHOT online server is running');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

const players = new Map(); // socket id -> player
const figureState = new Map(); // figure room -> latest Figure state, for players who join later

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const publicInfo = (p) => ({
    id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    health: p.health, dead: p.dead, kills: p.kills, deaths: p.deaths, appearance: p.appearance
});

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

// The Figure's room is only valid if the Figure is still connected in it
function figureIn(room) {
    for (const p of players.values()) if (p.room === room && p.role === 'figure') return p;
    return null;
}

io.on('connection', (socket) => {
    socket.on('join', (data = {}) => {
        const map = MAPS.includes(data.map) ? data.map : 'og';
        const figureMode = data.figure === true;
        const room = figureMode ? 'fig-' + map : map;
        const inRoom = [...players.values()].filter((p) => p.room === room);
        if (inRoom.length >= MAX_PER_ROOM) {
            socket.emit('full');
            socket.disconnect(true);
            return;
        }
        // Only one Figure per room. If someone asks for it while it's taken, they join as a survivor.
        let role = 'player';
        if (figureMode) role = (data.role === 'figure' && !figureIn(room)) ? 'figure' : 'survivor';

        const player = {
            id: socket.id, name: String(data.name || 'Operative').slice(0, 16), map: map, room: room, role: role,
            x: 0, y: 0, z: 0, yaw: 0, health: 100, dead: false, kills: 0, deaths: 0,
            appearance: cleanAppearance(data.appearance)
        };
        players.set(socket.id, player);
        socket.join(room);
        socket.emit('joined', { role: role, room: room });
        socket.emit('roster', inRoom.map(publicInfo));
        socket.to(room).emit('playerJoined', publicInfo(player));
        if (figureMode && role === 'survivor' && figureState.has(room)) socket.emit('figureState', figureState.get(room));
    });

    socket.on('appearance', (a = {}) => {
        const p = players.get(socket.id);
        if (!p) return;
        p.appearance = cleanAppearance(a);
        io.to(p.room).emit('appearance', { id: p.id, appearance: p.appearance });
    });

    socket.on('state', (s = {}) => {
        const p = players.get(socket.id);
        if (!p) return;
        p.x = num(s.x); p.y = num(s.y); p.z = num(s.z); p.yaw = num(s.yaw);
    });

    // The Figure's controller sends its position, facing, legs and body HP ~10 times a second
    socket.on('figureState', (s = {}) => {
        const p = players.get(socket.id);
        if (!p || p.role !== 'figure') return;
        const state = {
            id: p.id,
            x: num(s.x), y: num(s.y), z: num(s.z), yaw: num(s.yaw),
            limbs: Array.isArray(s.limbs) ? s.limbs.slice(0, 16).map((v) => !!v) : [],
            bodyHP: num(s.bodyHP), moving: !!s.moving, attackIndex: num(s.attackIndex)
        };
        figureState.set(p.room, state);
        socket.to(p.room).volatile.emit('figureState', state);
    });

    // A survivor's shot hit the Figure: tell the Figure's controller to take the damage
    socket.on('figureHit', (h = {}) => {
        const me = players.get(socket.id);
        if (!me || me.role !== 'survivor' || me.dead) return;
        const fig = figureIn(me.room);
        if (!fig) return;
        io.to(fig.id).emit('figureHurt', {
            amount: Math.max(0, Math.min(200, num(h.amount))), from: me.id, weapon: String(h.weapon || 'Unknown').slice(0, 24)
        });
    });

    // The Figure's controller ends the round (its body was destroyed)
    socket.on('roundOver', (d = {}) => {
        const p = players.get(socket.id);
        if (!p || p.role !== 'figure') return;
        io.to(p.room).emit('roundOver', { title: String(d.title || 'ROUND OVER').slice(0, 40), sub: String(d.sub || '').slice(0, 120) });
    });

    // A shot landed on another player: tell the victim's game to take the damage
    socket.on('hit', (h = {}) => {
        const me = players.get(socket.id);
        const target = players.get(h.targetId);
        if (!me || !target || target.room !== me.room || target.dead || target.id === me.id) return;
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
        if (killer && killer.room === victim.room && killer.id !== victim.id) killer.kills++;
        io.to(victim.room).emit('kill', {
            killerId: killer ? killer.id : null,
            killer: killer ? killer.name : 'Unknown',
            victimId: victim.id,
            victim: victim.name,
            weapon: String(d.weapon || 'Unknown').slice(0, 24)
        });
        // Figure rounds: the Figure wins once no survivor is left alive
        if (victim.room.startsWith('fig-') && figureIn(victim.room)) {
            const anyAlive = [...players.values()].some((p) => p.room === victim.room && p.role === 'survivor' && !p.dead);
            if (!anyAlive) io.to(victim.room).emit('roundOver', { title: 'FIGURE WINS', sub: 'All survivors have been eliminated.' });
        }
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
        io.to(p.room).emit('playerLeft', p.id);
        if (p.role === 'figure') {
            figureState.delete(p.room);
            io.to(p.room).emit('figureLeft');
        }
    });
});

// Free-for-all: everyone in a map room gets the positions of the others about 20 times a second
setInterval(() => {
    for (const room of [...MAPS, ...MAPS.map((m) => 'fig-' + m)]) {
        const list = [...players.values()].filter((p) => p.room === room).map(publicInfo);
        if (list.length) io.to(room).volatile.emit('states', list);
    }
}, 50);

httpServer.listen(PORT, () => console.log(`LITESHOT online server on port ${PORT}`));
