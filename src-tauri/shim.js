// Stands in for the Java half of the official Android app: Cordova's JS bridge (window._cordovaNative + the
// gap_init prompt) dispatches to the services below, so the APK's untouched cordova.js/plugins and the game
// code see the same plugin results the Android build returns. Injected before any page script runs.
(function (CONFIG) {
	'use strict';
	if (location.protocol !== 'file:') return; // only the game shell, never pages it opens

	var BASE = 'http://cdvfile.localhost/'; // served by src-tauri/src/cdvfile.rs
	var NOREPLY = {};
	var apk = CONFIG.apk, fetch = window.fetch.bind(window);
	var nativeAlert = window.alert.bind(window), nativeConfirm = window.confirm.bind(window), nativePrompt = window.prompt.bind(window);

	// --- identity: what JS can read about the platform -------------------------------------------------
	function getter(obj, key, value) {
		try { Object.defineProperty(obj, key, { get: function () { return value; }, configurable: true }); } catch (e) { /* keep native */ }
	}
	getter(Navigator.prototype, 'platform', 'Linux aarch64');
	if (navigator.userAgentData) {
		var major = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1];
		var brands = [{ brand: 'Android WebView', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not?A_Brand', version: '99' }];
		var uaData = {
			brands: brands, mobile: false, platform: 'Android',
			getHighEntropyValues: function () {
				return Promise.resolve({ brands: brands, mobile: false, platform: 'Android', platformVersion: CONFIG.device.version + '.0.0', model: CONFIG.device.model, architecture: '', bitness: '' });
			},
			toJSON: function () { return { brands: brands, mobile: false, platform: 'Android' }; }
		};
		getter(Navigator.prototype, 'userAgentData', uaData);
	}
	// Android's device plugin returns a stable per-install id (ANDROID_ID: 16 hex chars).
	var uuid = localStorage.getItem('__device_uuid');
	if (!uuid) {
		uuid = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) { return (b + 256).toString(16).slice(1); }).join('');
		localStorage.setItem('__device_uuid', uuid);
	}
	var device = Object.assign({ uuid: uuid }, CONFIG.device);
	// Android WebView has these and lacks SharedWorker; the bundled fingerprinting counts all three.
	getter(window, 'orientation', 90);
	window.onorientationchange = null;
	try { delete window.SharedWorker; } catch (e) { /* non-configurable: keep */ }

	// Window resizes. On a device the game never re-lays out: it caches the viewport size in its (module-private)
	// dimensions object and only adds its desktop resize listener (gui._resizeUi) when !isDevice. The in-game layout
	// code first assigns dims.sideBarWidth, which is not an own property yet, so a one-shot Object.prototype setter
	// captures that object; a resize then clears the cached size and runs the game's own _resizeUi.
	var dims = null, resizeTimer;
	function relayout() {
		var gui = window.gui;
		if (dims && gui && gui.isConnected && gui._resizeUi) {
			dims.viewportWidth = 0;
			dims.viewportHeight = 0;
			gui._resizeUi();
		} else {
			var body = document.getElementById('dofusBody'); // login screens: only this height is pinned
			if (body) body.style.height = innerHeight + 'px';
		}
	}
	function scheduleRelayout() { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 250); }
	Object.defineProperty(Object.prototype, 'sideBarWidth', {
		configurable: true,
		set: function (v) {
			if ('viewportWidth' in this && 'mapLeft' in this) {
				dims = this;
				delete Object.prototype.sideBarWidth;
				// the first in-game layout used the size cached at app start; redo it once the game is connected
				(function waitConnected() {
					if (window.gui && window.gui.isConnected) scheduleRelayout(); else setTimeout(waitConnected, 500);
				})();
			}
			Object.defineProperty(this, 'sideBarWidth', { value: v, writable: true, enumerable: true, configurable: true });
		}
	});
	window.addEventListener('resize', scheduleRelayout);

	// Error reports sent to Ankama carry stack traces: show Android's URLs, not ours (which include the Windows path).
	var pageDir = location.href.slice(0, location.href.lastIndexOf('/') + 1);
	window.fetch = function (input, init) {
		if (typeof input === 'string' && /\/logger$/.test(input) && init && typeof init.body === 'string') {
			init.body = init.body
				.split(BASE + 'persistent/').join('file:///__cdvfile_persistent__/')
				.split(BASE + 'temporary/').join('file:///__cdvfile_temporary__/')
				.split(pageDir).join('file:///android_asset/www/');
		}
		return fetch(input, init);
	};
	document.addEventListener('DOMContentLoaded', function () {
		for (var k in window) if (k.indexOf('__TAURI') === 0) try { delete window[k]; } catch (e) { /* ignore */ }
	});

	// --- bridge ----------------------------------------------------------------------------------------
	function reply(id, ok, payload, keep) {
		setTimeout(function () { window.cordova.callbackFromNative(id, ok, ok ? 1 : 9, [payload], !!keep); }, 0);
	}
	function emit(id, payload) { if (id) reply(id, true, payload, true); }

	window.prompt = function (message, def) {
		if (typeof def === 'string' && def.indexOf('gap') === 0) return def.indexOf('gap_init:') === 0 ? '1' : '';
		return nativePrompt(message, def);
	};
	window._cordovaNative = {
		exec: function (secret, service, action, id, argsJson) {
			var fn = services[service] && services[service][action];
			if (!fn) {
				// shortcut: unknown plugins (push, analytics, billing) never answer, add a service if the game waits on one
				console.debug('[native] unhandled', service, action, argsJson);
				return '';
			}
			Promise.resolve()
				.then(function () { return fn(JSON.parse(argsJson), id); })
				.then(function (v) { if (v !== NOREPLY) reply(id, true, v === undefined ? null : v); },
					function (e) { console.debug('[native] fail', service, action, e); reply(id, false, e); });
			return '';
		},
		setNativeToJsBridgeMode: function () {},
		retrieveJsMessages: function () { return ''; }
	};

	// --- file system (cordova-plugin-file, Android semantics) ------------------------------------------
	function parse(url) {
		var m = /^(?:cdvfile:\/\/localhost\/|http:\/\/cdvfile\.localhost\/|file:\/\/\/__cdvfile_)(persistent|temporary)(?:__)?(\/[^?#]*)?/.exec(url);
		if (!m) throw 5; // ENCODING_ERR
		return { fs: m[1], path: decodeURIComponent(m[2] || '/') };
	}
	function join(base, rel) {
		var parts = [];
		((rel.charAt(0) === '/' ? '' : base) + '/' + rel).split('/').forEach(function (p) {
			if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p);
		});
		return '/' + parts.join('/');
	}
	function urlPath(fs, path) { return '/' + fs + path.split('/').map(encodeURIComponent).join('/'); }
	function op(fs, path, name, body, headers) {
		return fetch(BASE.slice(0, -1) + urlPath(fs, path), { method: 'POST', body: body, headers: Object.assign({ 'x-op': name }, headers) })
			.then(function (r) {
				if (r.status === 404) throw 1; // NOT_FOUND_ERR
				if (!r.ok) throw name === 'remove' ? 9 : 4; // INVALID_MODIFICATION_ERR (non-empty dir) / NOT_READABLE_ERR
				return r;
			});
	}
	function stat(fs, path) { return op(fs, path, 'stat').then(function (r) { return r.json(); }); }
	function entry(fs, path, dir) {
		var full = dir && path !== '/' ? path + '/' : path;
		return {
			isFile: !dir, isDirectory: dir, name: path.split('/').pop(), fullPath: full,
			filesystemName: fs, filesystem: fs === 'temporary' ? 0 : 1, nativeURL: BASE.slice(0, -1) + urlPath(fs, full)
		};
	}
	function getEntry(dir) {
		return function (a) {
			var base = parse(a[0]), path = join(base.path, a[1]), o = a[2] || {};
			return stat(base.fs, path).then(function (s) {
				if (o.create && o.exclusive) throw 12; // PATH_EXISTS_ERR
				if (s.dir !== dir) throw 11; // TYPE_MISMATCH_ERR
				return entry(base.fs, path, dir);
			}, function (code) {
				if (code !== 1 || !o.create) throw code;
				return op(base.fs, path, dir ? 'mkdir' : 'touch').then(function () { return entry(base.fs, path, dir); });
			});
		};
	}
	function fsRoot(name) {
		return op(name, '/', 'mkdir').then(function () { return { name: name, root: entry(name, '/', true) }; });
	}
	function read(a, cb) {
		var f = parse(a[0]), n = a.length;
		return op(f.fs, f.path, 'read', undefined, { 'x-start': String(a[n - 2]), 'x-end': String(a[n - 1]) })
			.then(function (r) { return r.arrayBuffer().then(function (buf) { return cb(buf, r.headers.get('content-type')); }); });
	}
	function bytesToBinary(buf) {
		var s = '', u = new Uint8Array(buf);
		for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
		return s;
	}
	function moveOrCopy(name) {
		return function (a) {
			var src = parse(a[0]), parent = parse(a[1]), dest = join(parent.path, a[2] || src.path.split('/').pop());
			return op(src.fs, src.path, name, undefined, { 'x-dest': urlPath(parent.fs, dest) })
				.then(function () { return stat(parent.fs, dest); })
				.then(function (s) { return entry(parent.fs, dest, s.dir); });
		};
	}

	// Called by the Rust side with e.g. dofustouch://authorized?code=...; same payload as the Android plugin.
	var deepLinkChannel = null;
	Object.defineProperty(window, Symbol.for('deeplink'), {
		value: function (url) {
			var u = new URL(url);
			emit(deepLinkChannel, {
				url: url, scheme: u.protocol.slice(0, -1), host: u.host, path: u.pathname,
				queryString: u.search.slice(1), fragment: u.hash.slice(1)
			});
		}
	});

	var appDir = 'file:///data/user/0/' + apk.package + '/';
	// every action succeeds with null, except the listed ones
	function okExcept(special) {
		return new Proxy({}, { get: function (t, action) { return special[action] || function () { return null; }; } });
	}
	var ok = okExcept({});

	var services = {
		CoreAndroid: {
			messageChannel: function () { return NOREPLY; }, // pause/resume/back events; not forwarded on desktop
			show: function () { return null; },
			exitApp: function () { window.close(); return null; },
			clearCache: function () { return null; }, clearHistory: function () { return null; },
			overrideBackbutton: function () { return null; }, overrideButton: function () { return null; }
		},
		Device: { getDeviceInfo: function () { return device; } },
		AppInfo: {
			getAppInfo: function () { return { identifier: apk.package, version: apk.versionName, build: apk.versionCode }; },
			getVersion: function () { return apk.versionName; },
			getIdentifier: function () { return apk.package; }
		},
		AppSettings: {
			get: function (keys) {
				var out = {};
				keys.forEach(function (k) { if (apk.prefs[k.toLowerCase()] !== undefined) out[k] = apk.prefs[k.toLowerCase()]; });
				return out;
			}
		},
		NetworkStatus: { getConnectionInfo: function (a, id) { emit(id, 'wifi'); return NOREPLY; } },
		ChromeSystemMemory: { getInfo: function () { return { capacity: 8 * 1073741824, availableCapacity: 4 * 1073741824 }; } },
		MobileAccessibility: new Proxy({}, {
			get: function (t, action) {
				return function () { return action === 'getTextZoom' ? 100 : String(action).indexOf('is') === 0 ? false : null; };
			}
		}),
		Notification: {
			alert: function (a) { nativeAlert(a[0]); return null; },
			confirm: function (a) { return nativeConfirm(a[0]) ? 1 : 2; },
			prompt: function (a) { var v = nativePrompt(a[0], a[3] || ''); return { buttonIndex: v === null ? 2 : 1, input1: v || '' }; },
			beep: function () { return null; }, activityStart: function () { return null; }, activityStop: function () { return null; },
			progressStart: function () { return null; }, progressValue: function () { return null; }, progressStop: function () { return null; }
		},
		SplashScreen: ok, CordovaSplashScreenPlugin: ok, NavigationBar: ok, PowerManagement: ok, LaunchReview: ok,
		StatusBar: okExcept({ _ready: function () { return true; } }), // answers with isVisible
		Keyboard: okExcept({ init: function () { return NOREPLY; } }), // event channel: show/hide strings only
		Media: okExcept({ messageChannel: function () { return NOREPLY; } }),
		// Asset cache: downloadFile(url, relPath) keeps files under persistent/wizassets/ and answers the local URL.
		WizAssetsPlugin: (function () {
			var DIR = '/wizassets/';
			function remove(rel) { return op('persistent', join(DIR, rel), 'remove').then(function () { return null; }, function () { return null; }); }
			return okExcept({
				downloadFile: function (a) {
					var path = join(DIR, a[1]), url = BASE.slice(0, -1) + urlPath('persistent', path);
					return stat('persistent', path).then(function () { return url; }, function () {
						return fetch(a[0])
							.then(function (r) { if (!r.ok) throw 'HTTP ' + r.status + ' ' + a[0]; return r.arrayBuffer(); })
							.then(function (buf) { return op('persistent', path, 'write', buf, { 'x-pos': '0' }); })
							.then(function () { return url; });
					});
				},
				deleteFile: function (a) {
					try { var f = parse(a[0]); return op(f.fs, f.path, 'remove').then(function () { return null; }); } catch (e) { return remove(a[0]); }
				},
				deleteFiles: function (a) { return Promise.all(a.map(remove)).then(function () { return null; }); }
			});
		})(),
		CDVOrientation: ok,
		// No Google Play Games / Custom Tabs on desktop: report them unavailable like a device without them.
		GameCenter: new Proxy({}, { get: function () { return function () { throw 'not available'; }; } }),
		// The Rust side turns window.open into the Ankama login window and closes it after the deep link.
		BrowserTab: {
			isAvailable: function () { return true; },
			openUrl: function (a) { window.open(a[0], '_blank'); return null; },
			close: function () { return null; }
		},
		IonicDeeplinkPlugin: {
			onDeepLink: function (a, id) { deepLinkChannel = id; return NOREPLY; },
			canOpenApp: function () { return false; }
		},
		InAppBrowser: {
			open: function (a) { window.open(a[0], '_blank'); return NOREPLY; },
			close: function () { return null; }, show: function () { return null; }, hide: function () { return null; }
		},
		File: {
			requestAllPaths: function () {
				return {
					applicationDirectory: 'file:///android_asset/', applicationStorageDirectory: appDir,
					dataDirectory: appDir + 'files/', cacheDirectory: appDir + 'cache/'
				};
			},
			requestAllFileSystems: function () {
				return Promise.all([fsRoot('temporary'), fsRoot('persistent')]).then(function (r) {
					return r.map(function (f) { return Object.assign(f.root, { filesystemName: f.name }); });
				});
			},
			requestFileSystem: function (a) { return fsRoot(a[0] === 0 ? 'temporary' : 'persistent'); },
			resolveLocalFileSystemURI: function (a) {
				var f = parse(a[0]);
				return stat(f.fs, f.path).then(function (s) { return entry(f.fs, f.path.replace(/(.)\/$/, '$1'), s.dir); });
			},
			setMetadata: function () { return null; }, // only iOS backup flags
			getFile: getEntry(false),
			getDirectory: getEntry(true),
			getParent: function (a) { var f = parse(a[0]); return entry(f.fs, join(f.path, '..'), true); },
			getFileMetadata: function (a) {
				var f = parse(a[0]);
				return stat(f.fs, f.path).then(function (s) {
					return { size: s.size, type: '', name: f.path.split('/').pop(), fullPath: f.path, lastModifiedDate: s.mtime };
				});
			},
			readEntries: function (a) {
				var d = parse(a[0]);
				return op(d.fs, d.path, 'list').then(function (r) { return r.json(); }).then(function (list) {
					return list.map(function (e) { return entry(d.fs, join(d.path, e.name), e.dir); });
				});
			},
			remove: function (a) { var f = parse(a[0]); if (f.path === '/') throw 9; return op(f.fs, f.path, 'remove').then(function () { return null; }); },
			removeRecursively: function (a) { var f = parse(a[0]); return op(f.fs, f.path, 'rmrf').then(function () { return null; }); },
			moveTo: moveOrCopy('move'),
			copyTo: moveOrCopy('copy'),
			write: function (a) {
				var f = parse(a[0]);
				var data = a[3] ? Uint8Array.from(atob(a[1]), function (c) { return c.charCodeAt(0); }) : new TextEncoder().encode(a[1]);
				return op(f.fs, f.path, 'write', data, { 'x-pos': String(a[2] || 0) }).then(function () { return data.length; });
			},
			truncate: function (a) { var f = parse(a[0]); return op(f.fs, f.path, 'truncate', undefined, { 'x-pos': String(a[1]) }).then(function () { return a[1]; }); },
			readAsText: function (a) { return read(a, function (buf) { return new TextDecoder(a[1] || 'utf-8').decode(buf); }); },
			readAsArrayBuffer: function (a) { return read(a, function (buf) { return buf; }); },
			readAsBinaryString: function (a) { return read(a, bytesToBinary); },
			readAsDataURL: function (a) { return read(a, function (buf, type) { return 'data:' + type + ';base64,' + btoa(bytesToBinary(buf)); }); }
		},
		FileTransfer: {
			// Android's FileTransfer downloads natively (no CORS), creating parent dirs; progress, then the entry.
			download: function (a, id) {
				var src = a[0], target = parse(a[1]);
				var fail = function (status, e) { return { code: 3, source: src, target: a[1], http_status: status, exception: e ? String(e) : null }; };
				return fetch(src, { headers: a[4] || {}, credentials: 'include' })
					.then(function (r) { if (!r.ok) throw fail(r.status); return r.arrayBuffer(); })
					.then(function (buf) {
						emit(id, { lengthComputable: true, loaded: buf.byteLength, total: buf.byteLength });
						return op(target.fs, target.path, 'write', buf, { 'x-pos': '0' });
					})
					.then(function () { return entry(target.fs, target.path, false); },
						function (e) { throw e && e.code ? e : fail(0, e); });
			},
			abort: function () { return null; }
		},
		Yanap: (function () {
			var audios = {}, channel = null;
			function status(uid, s, info) { emit(channel, { msgType: 'statusUpdate', audioUid: uid, newStatus: s, additionalInfo: info }); }
			function local(p) { return String(p).replace(/^cdvfile:\/\/localhost\//, BASE); }
			return {
				messageChannel: function (a, id) { channel = id; return NOREPLY; },
				createAudioInstance: function (a) {
					var uid = a[0], el = new Audio();
					el.loop = a[1] === 'loop';
					el.oncanplaythrough = function () { el.oncanplaythrough = null; status(uid, 'LOADED'); };
					el.onended = function () { status(uid, 'STOPPED'); };
					el.onerror = function () { status(uid, 'ERROR', 'cannot load ' + a[2]); };
					audios[uid] = el;
					status(uid, 'LOADING');
					el.src = local(a[2]);
					return NOREPLY;
				},
				play: function (a) {
					var el = audios[a[0]];
					if (el) el.play().then(function () { status(a[0], el.loop ? 'LOOPING' : 'PLAYING'); }, function (e) { status(a[0], 'ERROR', String(e)); });
					return NOREPLY;
				},
				stop: function (a) { var el = audios[a[0]]; if (el) { el.pause(); el.currentTime = 0; status(a[0], 'STOPPED'); } return NOREPLY; },
				setVolume: function (a) { var el = audios[a[0]]; if (el) el.volume = Math.max(0, Math.min(1, a[1])); return NOREPLY; },
				release: function (a) {
					var el = audios[a[0]];
					if (el) { el.pause(); el.removeAttribute('src'); delete audios[a[0]]; status(a[0], 'RELEASED'); }
					return NOREPLY;
				}
			};
		})()
	};
})(__CONFIG__);
