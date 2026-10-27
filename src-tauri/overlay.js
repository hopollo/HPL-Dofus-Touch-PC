// App UI on top of the game: keyboard shortcuts, the About panel and the window title (character name).
// Panels open from the window menu (main.rs calls window[Symbol.for('overlay')](name)); Esc closes them.
// A bound key presses the N-th shortcut slot visible on screen (in the game's slot order) or the Ready/End turn
// button, the same way a mouse click does.
(function () {
	'use strict';
	if (location.protocol !== 'file:') return;

	var VERSION = '__VERSION__', REPO = '__REPO__', TITLE = '__TITLE__', CLIENT = '__CLIENT__';

	// --- keyboard shortcuts ---
	// Bindings match the physical key (event.code) so they work on any layout (AZERTY's top row types &é"'...);
	// label is what that key typed when it was bound.
	var STORE = 'dtpc.keybinds.v2';
	var SLOTS = 12;
	var actions = [];
	var defaults = {};
	for (var i = 1; i <= SLOTS; i++) {
		actions.push({ id: 'slot' + i, label: 'Slot ' + i });
		if (i <= 10) defaults['slot' + i] = { code: 'Digit' + (i % 10), label: String(i % 10) };
	}
	actions.push({ id: 'endTurn', label: 'Ready / End turn' });
	defaults.endTurn = { code: 'Space', label: 'Space' };
	var binds;
	try { binds = JSON.parse(localStorage.getItem(STORE)) || defaults; } catch (e) { binds = defaults; }
	function save() { try { localStorage.setItem(STORE, JSON.stringify(binds)); } catch (e) { /* stays in memory */ } }

	function onScreen(el) {
		var r = el.getBoundingClientRect();
		if (!r.width || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null;
		var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return hit && el.contains(hit) ? r : null;
	}
	function pressAt(el, x, y) {
		['mousedown', 'mouseup', 'click'].forEach(function (type) {
			el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
		});
	}
	function press(el) {
		var r = el.getBoundingClientRect();
		pressAt(el, r.left + r.width / 2, r.top + r.height / 2);
	}
	function fightButton() {
		return [].slice.call(document.querySelectorAll('.fightControlButtons .fightBtn')).filter(onScreen)[0];
	}
	// Tap the map on the player's own cell. The game resolves taps with convertScreenToSceneCoordinate, which
	// includes a varying scroll term that convertSceneToScreenCoordinate lacks, so solve for the screen point
	// the game maps back to the player's position, and only tap once it verifiably resolves to that cell.
	function tapSelf() {
		var fg = window.foreground, iso = window.isoEngine, me = iso && iso.actorManager && iso.actorManager.userActor;
		if (!fg || !me) return;
		var toScene = fg.convertScreenToSceneCoordinate.bind(fg);
		var p = fg.convertSceneToScreenCoordinate(me._x, me._y), a = toScene(p.x, p.y);
		var x = p.x - (a.x - me._x) / ((toScene(p.x + 1, p.y).x - a.x) || 1);
		var y = p.y - (a.y - me._y) / ((toScene(p.x, p.y + 1).y - a.y) || 1);
		var hit = iso.mapRenderer.grid.getCellAtSceneCoordinate(toScene(x, y));
		if (!hit || hit.cell !== me.cellId) return; // never cast on a neighbouring cell
		var target = document.elementFromPoint(x, y);
		if (target) pressAt(target, x, y);
	}
	var DOUBLE_MS = 350, lastSlot = null, lastAt = 0;
	function run(id) {
		if (id === 'endTurn') {
			// "Prêt" during placement and "Fin du tour" on your turn; the game shows one at a time
			var btn = fightButton();
			if (btn) press(btn);
			return;
		}
		// Same spell key twice in a fight: the first press selected the spell, the second casts it on yourself.
		var now = Date.now();
		if (id === lastSlot && now - lastAt < DOUBLE_MS && fightButton()) {
			lastSlot = null;
			tapSelf();
			return;
		}
		lastSlot = id;
		lastAt = now;
		// DOM order is the game's slot order (it fills the bar column by column)
		var slots = [].slice.call(document.querySelectorAll('.ShortcutSlot')).filter(onScreen);
		var slot = slots[Number(id.slice(4)) - 1];
		if (slot) press(slot);
	}
	function keyLabel(e) { return e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key; }

	// --- panels (closed shadow root: invisible to the game's CSS and DOM queries) ---
	var host = document.createElement('div');
	var root = host.attachShadow({ mode: 'closed' });
	root.innerHTML =
		'<style>' +
		':host{all:initial}' +
		'.p{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;width:320px;max-height:85vh;overflow:auto;' +
		'background:#0d3b3b;color:#fff;font:14px system-ui,sans-serif;border:2px solid #4fb3a9;border-radius:12px;padding:16px;box-shadow:0 8px 32px #000a}' +
		'h2{margin:0 0 4px;font-size:16px}p{margin:0 0 12px;color:#bfe3df;font-size:12px;line-height:1.45}' +
		'.r{display:flex;justify-content:space-between;align-items:center;margin:4px 0}' +
		'button{font:inherit;min-width:96px;padding:4px 8px;border-radius:6px;border:1px solid #4fb3a9;background:#124d4d;color:#fff;cursor:pointer}' +
		'button.w{background:#4fb3a9;color:#0d3b3b}button:focus-visible{outline:2px solid #fff}' +
		'.f{display:flex;gap:8px;margin-top:12px}.f button{flex:1}' +
		'.warn{color:#ffd28a}.v{color:#fff}' +
		'</style>' +
		'<div class="p keys" role="dialog" aria-label="Keyboard shortcuts" hidden><h2>Keyboard shortcuts</h2>' +
		'<p>Click a key, then press the new one. Esc clears it.<br>In a fight, press a spell key twice quickly to cast it on yourself.</p>' +
		'<div class="l"></div><div class="f"><button class="d">Defaults</button><button class="c">Close</button></div></div>' +
		'<div class="p about" role="dialog" aria-label="About" hidden><h2>' + TITLE + '</h2>' +
		'<p class="v">Version ' + VERSION + ' · game client ' + CLIENT + '</p>' +
		'<p class="u">Checking for updates…</p>' +
		'<p>Play Dofus Touch on PC with great performance, absolutely nothing more! No logins stored, no telemetry, ' +
		'no ads, never for cheating or abusing the game.</p>' +
		'<p class="warn">Warning: this is an unofficial client, not made or endorsed by Ankama. Using it may go against ' +
		'the game\'s terms of use and could get your account banned. Use it at your own risk.</p>' +
		'<div class="f"><button class="gh">GitHub</button><button class="c">Close</button></div></div>';
	var keysPanel = root.querySelector('.keys'), aboutPanel = root.querySelector('.about');
	var list = root.querySelector('.l'), waiting = null;

	function render() {
		list.innerHTML = '';
		actions.forEach(function (a) {
			var row = document.createElement('div'), label = document.createElement('span'), btn = document.createElement('button');
			row.className = 'r';
			label.textContent = a.label;
			btn.textContent = waiting === a.id ? 'Press a key…' : binds[a.id] ? binds[a.id].label : '—';
			btn.className = waiting === a.id ? 'w' : '';
			btn.setAttribute('aria-label', a.label + ' key');
			btn.onclick = function () { waiting = a.id; render(); };
			row.appendChild(label);
			row.appendChild(btn);
			list.appendChild(row);
		});
	}
	function closeAll() { keysPanel.hidden = aboutPanel.hidden = true; waiting = null; }
	root.querySelector('.d').onclick = function () { binds = JSON.parse(JSON.stringify(defaults)); save(); render(); };
	[].forEach.call(root.querySelectorAll('.c'), function (b) { b.onclick = closeAll; });
	root.querySelector('.gh').onclick = function () { window.open('https://github.com/' + REPO); };

	// Only network call of the app itself, made when About is opened: the latest release tag on GitHub.
	function checkUpdate() {
		var status = root.querySelector('.u');
		fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
			.then(function (r) { if (!r.ok) throw r.status; return r.json(); })
			.then(function (rel) {
				var latest = String(rel.tag_name || '').replace(/^v/, '');
				if (!latest || latest === VERSION) { status.textContent = 'You have the latest version.'; return; }
				status.textContent = 'Update available: ' + latest + ' → ';
				var a = document.createElement('button');
				a.textContent = 'Download';
				a.onclick = function () { window.open(rel.html_url); };
				status.appendChild(a);
			})
			.catch(function () { status.textContent = 'Could not check for updates.'; });
	}

	Object.defineProperty(window, Symbol.for('overlay'), {
		value: function (name) {
			closeAll();
			if (name === 'keybinds') { keysPanel.hidden = false; render(); }
			if (name === 'about') { aboutPanel.hidden = false; checkUpdate(); }
		}
	});

	window.addEventListener('keydown', function (e) {
		if (!keysPanel.hidden || !aboutPanel.hidden) {
			if (!waiting) { if (e.code === 'Escape') closeAll(); return; }
			e.preventDefault();
			for (var id in binds) if (binds[id].code === e.code) delete binds[id]; // one action per key
			if (e.code === 'Escape') delete binds[waiting]; else binds[waiting] = { code: e.code, label: keyLabel(e) };
			waiting = null;
			save();
			render();
			return;
		}
		var t = e.target;
		if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return; // typing in chat
		for (var action in binds) {
			if (binds[action].code === e.code) { e.preventDefault(); run(action); return; }
		}
	}, true);

	// --- window title: the character's name while in game (main.rs mirrors document.title) ---
	// shortcut: polls every 2 s instead of hooking the game's connection events; cheap and version-proof.
	setInterval(function () {
		var gui = window.gui, info = gui && gui.isConnected && gui.playerData && gui.playerData.characterBaseInformations;
		var title = (info && info.name) || TITLE;
		if (document.title !== title) document.title = title;
	}, 2000);

	document.addEventListener('DOMContentLoaded', function () { document.documentElement.appendChild(host); });
})();
