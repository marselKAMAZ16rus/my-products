// worker/core.mjs
var json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" } });
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
var hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((x) => x.toString(16).padStart(2, "0")).join("");

// worker/push.mjs
var enc = new TextEncoder();
var b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
var unb64 = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
var concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
var hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
var expand = async (key, info, size) => (await hmac(key, concat(info, new Uint8Array([1])))).slice(0, size);
function allowedPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && (["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com", "push.services.mozilla.com"].includes(u.hostname) || u.hostname.endsWith(".push.services.mozilla.com") || u.hostname.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}
async function makePush(subscription, payload, env) {
  const ua = unb64(subscription.p256dh), auth = unb64(subscription.auth), pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]), as = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), remote = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []), shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, pair.privateKey, 256));
  const prkKey = await hmac(auth, shared), ikm = await expand(prkKey, concat(enc.encode("WebPush: info\0"), ua, as), 32), salt = crypto.getRandomValues(new Uint8Array(16)), prk = await hmac(salt, ikm), cek = await expand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await expand(prk, enc.encode("Content-Encoding: nonce\0"), 12), key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]))));
  const record = new Uint8Array(4);
  new DataView(record.buffer).setUint32(0, 4096, false);
  const body = concat(salt, record, new Uint8Array([65]), as, encrypted), header = b64(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))), claims = b64(enc.encode(JSON.stringify({ aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1e3) + 43200, sub: env.REEF_PUSH_SUBJECT }))), input = header + "." + claims, privateKey = await crypto.subtle.importKey("jwk", JSON.parse(env.REEF_VAPID_PRIVATE), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]), signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(input));
  return { body, headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", "authorization": "vapid t=" + input + "." + b64(signature) + ", k=" + env.REEF_VAPID_PUBLIC, ttl: "86400", urgency: "high" } };
}
async function sendPush(subscription, payload, env, fetchImpl = fetch) {
  if (!allowedPushEndpoint(subscription.endpoint)) return { expired: true, ok: false, status: 400 };
  const message = await makePush(subscription, payload, env), response = await fetchImpl(subscription.endpoint, { method: "POST", headers: message.headers, body: message.body, redirect: "manual", signal: AbortSignal.timeout(8e3) });
  const result = { ok: response.ok, status: response.status, expired: [404, 410].includes(response.status) };
  await response.body?.cancel();
  return result;
}
async function recordPush(env, sub, payload, fetchImpl = fetch) {
  let result;
  try {
    result = await sendPush(sub, payload, env, fetchImpl);
  } catch {
    result = { ok: false, expired: false, status: 0 };
  }
  const error = result.ok ? "" : result.expired ? "\u041F\u043E\u0434\u043F\u0438\u0441\u043A\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430" : result.status === 401 || result.status === 403 ? "\u0421\u0435\u0440\u0432\u0438\u0441 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439 \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u043A\u043B\u044E\u0447 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F" : "\u0421\u0435\u0440\u0432\u0438\u0441 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D";
  await env.DB.prepare("UPDATE push_subscriptions SET last_status=?,last_attempt=?,last_success=CASE WHEN ? THEN ? ELSE last_success END,last_error=? WHERE id=?").bind(result.status, Math.floor(Date.now() / 1e3), result.ok ? 1 : 0, Math.floor(Date.now() / 1e3), error, sub.id).run();
  if (!result.ok) console.warn("Reef push delivery failed", JSON.stringify({ status: result.status, expired: result.expired }));
  return { ...result, error };
}
var pushRuns = /* @__PURE__ */ new WeakMap();
function deliverPush(env, fetchImpl = fetch) {
  if (pushRuns.has(env)) return pushRuns.get(env);
  const run = drainPush(env, fetchImpl).finally(() => pushRuns.delete(env));
  pushRuns.set(env, run);
  return run;
}
async function drainPush(env, fetchImpl) {
  if (!env.REEF_VAPID_PRIVATE || !env.REEF_VAPID_PUBLIC) return;
  const now = Math.floor(Date.now() / 1e3);
  await env.DB.prepare("UPDATE notifications SET pushed=0 WHERE pushed=2 AND (push_claimed IS NULL OR push_claimed<?)").bind(now - 60).run();
  await env.DB.prepare("UPDATE notifications SET pushed=1 WHERE pushed=0 AND NOT EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.member=notifications.recipient)").run();
  const found = (await env.DB.prepare("SELECT n.id,n.recipient,n.kind,n.push_attempts,m.name FROM notifications n JOIN members m ON m.id=n.actor WHERE n.pushed=0 AND n.push_attempts<6 AND n.next_push<=? ORDER BY n.created DESC LIMIT 10").bind(now).all()).results;
  const labels = { like: "\u043E\u0446\u0435\u043D\u0438\u043B(\u0430) \u0432\u0430\u0448\u0443 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E", comment: "\u043F\u0440\u043E\u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043B(\u0430) \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E", reply: "\u043E\u0442\u0432\u0435\u0442\u0438\u043B(\u0430) \u043D\u0430 \u0432\u0430\u0448 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439", comment_like: "\u043E\u0446\u0435\u043D\u0438\u043B(\u0430) \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439", friend: "\u0442\u0435\u043F\u0435\u0440\u044C \u0443 \u0432\u0430\u0441 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F\u0445", friend_request: "\u0445\u043E\u0447\u0435\u0442 \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0432\u0430\u0441 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F", invite_joined: "\u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043B\u0441\u044F(\u0430\u0441\u044C) \u043F\u043E \u0432\u0430\u0448\u0435\u043C\u0443 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044E", message: "\u043E\u0442\u043F\u0440\u0430\u0432\u0438\u043B(\u0430) \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435", photo_tag: "\u043E\u0442\u043C\u0435\u0442\u0438\u043B(\u0430) \u0432\u0430\u0441 \u043D\u0430 \u0444\u043E\u0442\u043E", tag_comment: "\u043E\u0441\u0442\u0430\u0432\u0438\u043B(\u0430) \u043F\u043E\u0434\u043F\u0438\u0441\u044C \u043D\u0430 \u0444\u043E\u0442\u043E" };
  await Promise.all(found.map(async (n) => {
    const claim = await env.DB.prepare("UPDATE notifications SET pushed=2,push_claimed=?,push_attempts=push_attempts+1 WHERE id=? AND pushed=0 RETURNING id").bind(now, n.id).first();
    if (!claim) return;
    let retry = false;
    try {
      const subscriptions = (await env.DB.prepare("SELECT * FROM push_subscriptions WHERE member=? LIMIT 10").bind(n.recipient).all()).results;
      await Promise.all(subscriptions.map(async (sub) => {
        try {
          const result = await recordPush(env, sub, { title: "Reef", body: labels[n.kind] ? n.name + " " + labels[n.kind] : "\u041D\u043E\u0432\u043E\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u0432 \u0432\u0430\u0448\u0435\u043C \u043A\u0440\u0443\u0433\u0435", tag: n.id, url: "/#notifications" }, fetchImpl);
          if (result.expired) await env.DB.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(sub.id).run();
          else if (!result.ok) retry = true;
        } catch {
          retry = true;
        }
      }));
    } catch {
      retry = true;
    }
    await env.DB.prepare("UPDATE notifications SET pushed=?,next_push=?,push_claimed=NULL WHERE id=?").bind(retry ? 0 : 1, retry ? now + Math.min(300, 5 * 2 ** n.push_attempts) : 0, n.id).run();
  }));
}
async function pushApi(request, env, m, c) {
  const path = new URL(request.url).pathname;
  if (path === "/reef-api/push/key") {
    if (!env.REEF_VAPID_PUBLIC) fail(503, "Push-\u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u0435\u0449\u0451 \u043D\u0430\u0441\u0442\u0440\u0430\u0438\u0432\u0430\u044E\u0442\u0441\u044F");
    return json({ key: env.REEF_VAPID_PUBLIC });
  }
  if (path === "/reef-api/push/status" && request.method === "POST") {
    const d = await c.body(request, 4e3), sub = await c.one(env, "SELECT last_status,last_attempt,last_success,last_error FROM push_subscriptions WHERE id=? AND member=?", await hash(String(d.endpoint)), m.id);
    return json({ registered: !!sub, status: sub?.last_status, attempt: sub?.last_attempt, success: sub?.last_success, error: sub?.last_error || "" });
  }
  if (path === "/reef-api/push/test" && request.method === "POST") {
    await c.rate(env, "push-test:" + m.id, 3, 60);
    const d = await c.body(request, 4e3), sub = await c.one(env, "SELECT * FROM push_subscriptions WHERE id=? AND member=?", await hash(String(d.endpoint)), m.id);
    if (!sub) fail(400, "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043D\u0430 \u044D\u0442\u043E\u043C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435");
    if (!env.REEF_VAPID_PRIVATE || !env.REEF_VAPID_PUBLIC) fail(503, "\u0421\u0435\u0440\u0432\u0438\u0441 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439 \u0435\u0449\u0451 \u043D\u0430\u0441\u0442\u0440\u0430\u0438\u0432\u0430\u0435\u0442\u0441\u044F");
    const result = await recordPush(env, sub, { title: "Reef", body: "\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u044E\u0442. \u041E\u043D\u0438 \u043F\u0440\u0438\u0445\u043E\u0434\u044F\u0442 \u0438 \u043F\u0440\u0438 \u0437\u0430\u043A\u0440\u044B\u0442\u043E\u043C \u0441\u0430\u0439\u0442\u0435.", tag: "reef-device-test", url: "/#notifications" });
    if (!result.ok) fail(502, result.error + (result.expired ? ". \u0412\u044B\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0438 \u0441\u043D\u043E\u0432\u0430 \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F." : ". \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443 \u043F\u043E\u0437\u0436\u0435."));
    return json({ ok: true, accepted: true });
  }
  if (path === "/reef-api/push/subscription" && request.method === "POST") {
    const d = await c.body(request, 8e3);
    if (!allowedPushEndpoint(d.endpoint) || typeof d.keys?.p256dh !== "string" || typeof d.keys?.auth !== "string") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u043F\u043E\u0434\u043F\u0438\u0441\u043A\u0430");
    try {
      if (unb64(d.keys.p256dh).length !== 65 || unb64(d.keys.auth).length !== 16) throw Error();
      await crypto.subtle.importKey("raw", unb64(d.keys.p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
    } catch {
      fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043A\u043B\u044E\u0447\u0438 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430");
    }
    const id = await hash(d.endpoint), existing = await c.one(env, "SELECT id FROM push_subscriptions WHERE id=? AND member=?", id, m.id);
    if (!existing && (await c.one(env, "SELECT count(*) AS n FROM push_subscriptions WHERE member=?", m.id)).n >= 10) fail(400, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D\u043D\u044B\u0445 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432");
    if (!existing) await c.stmt(env, "UPDATE notifications SET pushed=1 WHERE recipient=? AND pushed=0 AND NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE member=?)", m.id, m.id).run();
    await c.stmt(env, "INSERT INTO push_subscriptions(id,member,endpoint,p256dh,auth,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET member=excluded.member,p256dh=excluded.p256dh,auth=excluded.auth", id, m.id, d.endpoint, d.keys.p256dh, d.keys.auth, Math.floor(Date.now() / 1e3)).run();
    return json({ ok: true });
  }
  if (path === "/reef-api/push/subscription" && request.method === "DELETE") {
    const d = await c.body(request, 4e3);
    await c.stmt(env, "DELETE FROM push_subscriptions WHERE id=? AND member=?", await hash(String(d.endpoint)), m.id).run();
    return json({ ok: true });
  }
  return null;
}
export {
  allowedPushEndpoint,
  b64,
  deliverPush,
  makePush,
  pushApi,
  recordPush,
  sendPush,
  unb64
};
