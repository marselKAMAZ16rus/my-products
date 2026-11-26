// worker/people.mjs
var onlineSQL = (a) => `CASE WHEN ${a}.invisible=0 AND EXISTS(SELECT 1 FROM sessions presence WHERE presence.member=${a}.id AND presence.expires>unixepoch() AND presence.last_seen>=unixepoch()-70) THEN 1 ELSE 0 END`;
async function enrichPeople(env, people) {
  const ids = [...new Set(people.map((p) => p.member || p.actor || p.id).filter(Boolean))], statuses = /* @__PURE__ */ new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50), rows2 = (await env.DB.prepare(`SELECT m.id,${onlineSQL("m")} AS online FROM members m WHERE m.id IN (${batch.map(() => "?").join(",")})`).bind(...batch).all()).results;
    for (const row of rows2) statuses.set(row.id, !!row.online);
  }
  return people.map((p) => ({ ...p, online: statuses.get(p.member || p.actor || p.id) || false, avatar: p.avatar || (p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null) }));
}
async function canMessage(env, a, b) {
  if (a === b) return false;
  const friend = await env.DB.prepare("SELECT 1 FROM friends WHERE a=min(?,?) AND b=max(?,?)").bind(a, b, a, b).first();
  if (friend) return true;
  const touches = async (from, to) => !!await env.DB.prepare("SELECT 1 FROM likes l JOIN posts p ON p.id=l.post WHERE l.member=? AND p.author=? UNION SELECT 1 FROM comments c JOIN posts p ON p.id=c.post WHERE c.member=? AND p.author=? LIMIT 1").bind(from, to, from, to).first();
  return await touches(a, b) && await touches(b, a);
}

// worker/core.mjs
function graphFor(id2, edges, members) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const adj = /* @__PURE__ */ new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const result = /* @__PURE__ */ new Map([[id2, { depth: 0, path: [] }]]);
  let queue = [id2];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i], v = result.get(current);
    if (v.depth === 3) continue;
    for (const next of adj.get(current) || []) {
      if (!result.has(next) && byId.has(next)) {
        result.set(next, { depth: v.depth + 1, path: [...v.path, current] });
        queue.push(next);
      }
    }
  }
  return result;
}
function canRead(post, viewer, graph, excluded = []) {
  if (post.author === viewer) return true;
  if (excluded.includes(viewer)) return false;
  if (post.global) return true;
  const relation = graph.get(post.author);
  return !!relation && relation.depth <= post.depth && !excluded.includes(viewer);
}
function rank(posts) {
  const counts = /* @__PURE__ */ new Map();
  for (const p of posts) counts.set(p.author, (counts.get(p.author) || 0) + 1);
  return posts.map((p, i) => ({ p, score: ([1, 1, 0.5, 0.375][p.degree] || 1) / counts.get(p.author) / (1 + i * 0.035) })).sort((a, b) => b.score - a.score || b.p.created - a.p.created).map((x) => x.p);
}
var json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" } });
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
var randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
var hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((x) => x.toString(16).padStart(2, "0")).join("");
async function passwordHash(password, pepper, salt = crypto.randomUUID()) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(password + pepper), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 1e5, hash: "SHA-256" }, k, 256);
  return salt + ":" + Array.from(new Uint8Array(bits)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function checkPassword(password, stored, pepper) {
  const actual = await passwordHash(password, pepper, stored.split(":")[0]);
  let diff = actual.length ^ stored.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (stored.charCodeAt(i) || 0);
  return diff === 0;
}
function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
var isAdmin = (m) => m?.role === "owner" || m?.role === "admin";
function videoType(bytes) {
  if (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (["avif", "avis", "heic", "heix", "mif1", "msf1"].includes(brand)) return null;
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return "video/webm";
  return null;
}
function encodeCursor(value) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decodeCursor(value) {
  if (!value) return null;
  try {
    if (value.length > 1e3) throw Error();
    const c = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    if (!Number.isFinite(c.score) || !Number.isInteger(c.snapshot) || typeof c.id !== "string" || c.seq !== void 0 && !Number.isSafeInteger(c.seq)) throw Error();
    return c;
  } catch {
    fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043B\u0435\u043D\u0442\u044B");
  }
}

// worker/events.mjs
function notice(env, stmt2, recipient, actor, kind, target, post = null) {
  return stmt2(env, "INSERT OR IGNORE INTO notifications(id,recipient,actor,kind,target,post,created) SELECT ?,?,?,?,?,?,? WHERE ?<>?", [kind, recipient, actor, target, crypto.randomUUID()].join(":"), recipient, actor, kind, target, post, Math.floor(Date.now() / 1e3), recipient, actor);
}

// worker/badges.mjs
var badgeIcons = ["star", "crown", "diamond", "flame", "heart", "bolt", "flower", "code"];
function shapeBadge(b) {
  return { id: b.id, kind: b.kind, icon: b.icon, image: b.media_id ? "/media/" + b.media_id + "?thumb=1" : null, label: b.label, description: b.description, color: b.color };
}
async function badgesFor(env, ids) {
  const unique = [...new Set(ids)], result = /* @__PURE__ */ new Map();
  for (let offset = 0; offset < unique.length; offset += 50) {
    const batch = unique.slice(offset, offset + 50), data = (await env.DB.prepare(`SELECT * FROM custom_badges WHERE member IN (${batch.map(() => "?").join(",")}) ORDER BY created,id`).bind(...batch).all()).results;
    for (const row of data) {
      if (!result.has(row.member)) result.set(row.member, []);
      result.get(row.member).push(shapeBadge(row));
    }
  }
  return result;
}
async function enrichComments(env, comments) {
  const badges = await badgesFor(env, comments.map((c) => c.member));
  return enrichPeople(env, comments.map((c) => ({ ...c, badges: badges.get(c.member) || [], staffRole: ["owner", "admin", "moderator", "support"].includes(c.role) ? c.role : null, telegramVerified: false, avatar: c.avatar_id ? "/media/" + c.avatar_id + "?thumb=1" : null })));
}
async function badgeApi(request, env, m, c) {
  const path = new URL(request.url).pathname, match = path.match(/^\/reef-api\/admin\/members\/([^/]+)\/badges(?:\/([^/]+))?$/);
  if (!match) return null;
  if (!isAdmin(m)) fail(403, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443");
  const uid = match[1];
  if (!await c.one(env, "SELECT id FROM members WHERE id=?", uid)) fail(404, "\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  if (request.method === "GET" && !match[2]) return json({ badges: (await badgesFor(env, [uid])).get(uid) || [] });
  if (request.method === "DELETE" && match[2]) {
    await c.stmt(env, "DELETE FROM custom_badges WHERE id=? AND member=?", match[2], uid).run();
    return json({ ok: true });
  }
  if (request.method === "POST" && !match[2]) {
    const d = await c.body(request, 8e3), label = typeof d.label === "string" ? d.label.trim() : "", description = typeof d.description === "string" ? d.description.trim() : "";
    if (!label || label.length > 60 || description.length > 240 || !/^#[0-9a-f]{6}$/i.test(d.color || "")) fail(400, "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u2014 \u0434\u043E 60 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432, \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u2014 \u0434\u043E 240");
    if (!["symbol", "emoji", "image"].includes(d.kind)) fail(400, "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0442\u0438\u043F \u0437\u043D\u0430\u0447\u043A\u0430");
    if (d.kind === "symbol" && !badgeIcons.includes(d.icon)) fail(400, "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0438\u043A\u043E\u043D\u043A\u0443");
    if (d.kind === "emoji" && (typeof d.icon !== "string" || ![...d.icon].length || [...d.icon].length > 12 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(d.icon))) fail(400, "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u044D\u043C\u043E\u0434\u0437\u0438");
    let image = null;
    if (d.kind === "image") {
      if (typeof d.mediaId !== "string" || !d.mediaId) fail(400, "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0437\u043D\u0430\u0447\u043A\u0430");
      if (await c.one(env, "SELECT id FROM comments WHERE media_id=?", d.mediaId)) fail(400, "\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0443\u0436\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F");
      image = await c.one(env, "SELECT id FROM media WHERE id=? AND owner=? AND type LIKE 'image/%' AND NOT EXISTS(SELECT 1 FROM posts WHERE media_id=?) AND NOT EXISTS(SELECT 1 FROM post_media WHERE media=?)", d.mediaId, m.id, d.mediaId, d.mediaId);
      if (!image) fail(400, "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0437\u043D\u0430\u0447\u043A\u0430");
    }
    if ((await c.one(env, "SELECT count(*) AS n FROM custom_badges WHERE member=?", uid)).n >= 5) fail(400, "\u0423 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u0434\u043E \u043F\u044F\u0442\u0438 \u0437\u043D\u0430\u0447\u043A\u043E\u0432");
    const id2 = crypto.randomUUID();
    await c.stmt(env, "INSERT INTO custom_badges(id,member,issuer,kind,icon,media_id,label,description,color,created) VALUES(?,?,?,?,?,?,?,?,?,?)", id2, uid, m.id, d.kind, d.kind === "image" ? "" : d.icon, image?.id || null, label, description, d.color.toLowerCase(), Math.floor(Date.now() / 1e3)).run();
    return json({ ok: true, id: id2 }, 201);
  }
  fail(405, "\u041C\u0435\u0442\u043E\u0434 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F");
}

// worker/community.mjs
var now = () => Math.floor(Date.now() / 1e3);
function invitationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
async function resolveInviteHash(env, token) {
  if (typeof token !== "string") return "";
  if (!token.startsWith("code:")) return hash(token);
  const row = await env.DB.prepare("SELECT hash FROM invites WHERE code_hash=?").bind(await hash("invite-code:" + token.slice(5).replace(/[\s-]/g, "").toUpperCase())).first();
  return row?.hash || "";
}
async function createInvitation(env, stmt2, inviter, origin) {
  const token = randomToken(), code = invitationCode(), expires = now() + 7 * 86400;
  await stmt2(env, "INSERT INTO invites(hash,inviter,code_hash,expires,created) VALUES(?,?,?,?,?)", await hash(token), inviter, await hash("invite-code:" + code), expires, now()).run();
  return { url: origin + "/#invite=" + token, code: code.slice(0, 5) + "-" + code.slice(5), expires };
}
async function invitationCodeApi(request, env, c) {
  if (new URL(request.url).pathname !== "/reef-api/invite/code" || request.method !== "POST") return null;
  await c.rate(env, "invite-code:" + request.headers.get("cf-connecting-ip"), 30, 900);
  const d = await c.body(request), code = String(d.code || "").replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z2-9]{10}$/.test(code)) fail(400, "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043A\u043E\u0434 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F");
  const p = await c.one(env, "SELECT m.name FROM invites i JOIN members m ON m.id=i.inviter WHERE i.code_hash=? AND i.claimed_by IS NULL AND i.expires>? AND (m.role IN ('owner','admin') OR (SELECT count(*) FROM invites used WHERE used.inviter=i.inviter AND used.claimed_by IS NOT NULL)<m.invite_limit)", await hash("invite-code:" + code), now());
  if (!p) fail(410, "\u041A\u043E\u0434 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D \u0438\u043B\u0438 \u0441\u0440\u043E\u043A \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u0438\u0441\u0442\u0451\u043A");
  return json({ token: "code:" + code, name: p.name });
}
async function commentsFor(env, c, viewer, pid) {
  const comments = await enrichComments(env, await c.rows(env, "SELECT x.media_id,x.id,x.text,x.created,x.member,x.reply_to,parent.text AS reply_text,parent.member AS reply_member,pm.name AS reply_name,u.name,u.role,u.avatar_id,(SELECT count(*) FROM comment_likes l WHERE l.comment=x.id) AS likes,EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment=x.id AND l.member=?) AS liked FROM comments x JOIN members u ON u.id=x.member LEFT JOIN comments parent ON parent.id=x.reply_to LEFT JOIN members pm ON pm.id=parent.member WHERE x.post=? ORDER BY x.created ASC,x.rowid ASC LIMIT 150", viewer, pid));
  for (const comment of comments) {
    const a = comment.media_id ? await c.one(env, "SELECT id,type,thumbnail,width,height,kind,duration FROM media WHERE id=?", comment.media_id) : null;
    comment.media = a ? { ...a, url: "/media/" + a.id, thumbnail: a.thumbnail ? "/media/" + a.id + "?thumb=1" : null } : null;
  }
  return comments;
}
async function tagsFor(env, ids) {
  const out = /* @__PURE__ */ new Map();
  if (!ids.length) return out;
  const rows2 = (await env.DB.prepare(`SELECT t.*,m.name,m.avatar_id FROM photo_tags t JOIN members m ON m.id=t.member WHERE t.post IN (${ids.map(() => "?").join(",")}) ORDER BY t.created,t.id`).bind(...ids).all()).results;
  for (const t of await enrichPeople(env, rows2)) {
    if (!out.has(t.post)) out.set(t.post, []);
    out.get(t.post).push({ id: t.id, mediaId: t.media, member: t.member, name: t.name, avatar: t.avatar, online: t.online, x: t.x / 1e4, y: t.y / 1e4, comment: t.comment });
  }
  return out;
}
async function commentPermission(env, c, viewer, p) {
  if (viewer === p.author) return true;
  if (JSON.parse(p.comment_excluded || "[]").includes(viewer)) return false;
  if (p.comment_depth === 0) return false;
  const { graph } = await c.network(env, p.author);
  return (graph.get(viewer)?.depth ?? 4) <= (p.comment_depth ?? 4);
}
function commentPolicy(p) {
  return { depth: p.comment_depth ?? 4, excluded: JSON.parse(p.comment_excluded || "[]") };
}
async function community(request, env, m, c) {
  const { stmt: stmt2, one: one2, rows: rows2, body: body2, readPost: readPost2, rate: rate2 } = c, url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/reef-api/invites" && method === "POST") {
    await rate2(env, "invites:" + m.id, 20, 86400);
    if (!isAdmin(m) && (await one2(env, "SELECT count(*) AS n FROM invites WHERE inviter=? AND claimed_by IS NOT NULL", m.id)).n >= m.invite_limit) fail(403, "\u041B\u0438\u043C\u0438\u0442 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0439 \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D");
    return json(await createInvitation(env, stmt2, m.id, url.origin), 201);
  }
  const match = path.match(/^\/reef-api\/posts\/([^/]+)\/(likers|voters|comments|tags)$/);
  if (match) {
    const p = await readPost2(env, m.id, match[1]);
    if (method === "GET" && match[2] === "likers") {
      const after = url.searchParams.get("after") || "", people = await rows2(env, "SELECT u.id,u.name,u.avatar_id FROM likes l JOIN members u ON u.id=l.member WHERE l.post=? AND u.id>? ORDER BY u.id LIMIT 31", p.id, after);
      return json({ people: await enrichPeople(env, people.slice(0, 30)), next: people.length > 30 ? people[29].id : null });
    }
    if (method === "GET" && match[2] === "voters") {
      if (!p.poll) fail(404, "\u041E\u043F\u0440\u043E\u0441 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
      const options = JSON.parse(p.poll), after = url.searchParams.get("after") || "", people = await rows2(env, "SELECT u.id,u.name,u.avatar_id,v.option FROM poll_votes v JOIN members u ON u.id=v.member WHERE v.post=? AND u.id>? ORDER BY u.id LIMIT 51", p.id, after);
      return json({ options, people: await enrichPeople(env, people.slice(0, 50)), next: people.length > 50 ? people[49].id : null });
    }
    if (match[2] === "comments") {
      if (method === "GET") return json({ comments: await commentsFor(env, c, m.id, p.id), canComment: await commentPermission(env, c, m.id, p) });
      if (method === "POST") {
        if (!await commentPermission(env, c, m.id, p)) fail(403, "\u0410\u0432\u0442\u043E\u0440 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u043B \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438 \u043A \u044D\u0442\u043E\u0439 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438");
        await rate2(env, "comments:" + m.id, 60);
        const d = await body2(request), text = String(d.text || "").trim();
        if (!text && !d.mediaId || text.length > 1e3) fail(400, "\u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u0438\u043B\u0438 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435. \u0422\u0435\u043A\u0441\u0442 \u2014 \u0434\u043E 1000 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
        let media = null;
        if (d.mediaId) {
          media = await one2(env, "SELECT * FROM media WHERE id=? AND owner=?", d.mediaId, m.id);
          if (!media || await one2(env, "SELECT id FROM posts WHERE media_id=? UNION SELECT post AS id FROM post_media WHERE media=? UNION SELECT id FROM members WHERE avatar_id=? UNION SELECT id FROM custom_badges WHERE media_id=? UNION SELECT id FROM comments WHERE media_id=?", d.mediaId, d.mediaId, d.mediaId, d.mediaId, d.mediaId)) fail(400, "\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
        }
        const parent = d.replyTo ? await one2(env, "SELECT id,member FROM comments WHERE id=? AND post=?", d.replyTo, p.id) : null;
        if (d.replyTo && !parent) fail(400, "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
        const id2 = crypto.randomUUID(), commands = [stmt2(env, "INSERT INTO comments(id,post,member,text,reply_to,media_id,created) VALUES(?,?,?,?,?,?,?)", id2, p.id, m.id, text, parent?.id || null, media?.id || null, now())];
        if (!parent || parent.member !== p.author) commands.push(notice(env, stmt2, p.author, m.id, "comment", id2, p.id));
        if (parent) commands.push(notice(env, stmt2, parent.member, m.id, "reply", id2, p.id));
        await env.DB.batch(commands);
        return json({ ok: true }, 201);
      }
    }
    if (match[2] === "tags" && method === "GET") return json({ tags: (await tagsFor(env, [p.id])).get(p.id) || [] });
  }
  const tagPath = path.match(/^\/reef-api\/photo-tags\/([^/]+)$/);
  if (tagPath && ["PUT", "DELETE"].includes(method)) {
    const tag = await one2(env, "SELECT * FROM photo_tags WHERE id=?", tagPath[1]);
    if (!tag) fail(404, "\u041E\u0442\u043C\u0435\u0442\u043A\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    const p = await readPost2(env, m.id, tag.post);
    if (method === "DELETE") {
      if (tag.member !== m.id && p.author !== m.id) fail(403, "\u041D\u0435\u043B\u044C\u0437\u044F \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0447\u0443\u0436\u0443\u044E \u043E\u0442\u043C\u0435\u0442\u043A\u0443");
      await stmt2(env, "DELETE FROM photo_tags WHERE id=?", tag.id).run();
      return json({ ok: true });
    }
    const d = await body2(request);
    if (d.x !== void 0 || d.y !== void 0) {
      if (p.author !== m.id) fail(403, "\u0422\u043E\u043B\u044C\u043A\u043E \u0430\u0432\u0442\u043E\u0440 \u043C\u043E\u0436\u0435\u0442 \u043C\u0435\u043D\u044F\u0442\u044C \u0440\u0430\u0441\u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435");
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || d.x < 0 || d.x > 1 || d.y < 0 || d.y > 1) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435");
      await stmt2(env, "UPDATE photo_tags SET x=?,y=? WHERE id=?", Math.round(d.x * 1e4), Math.round(d.y * 1e4), tag.id).run();
      return json({ ok: true });
    }
    if (tag.member !== m.id) fail(403, "\u041F\u043E\u0434\u043F\u0438\u0441\u044C \u043C\u043E\u0436\u0435\u0442 \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u0442\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u0439 \u0447\u0435\u043B\u043E\u0432\u0435\u043A");
    const comment = String(d.comment || "").trim();
    if (comment.length > 140) fail(400, "\u041F\u043E\u0434\u043F\u0438\u0441\u044C \u2014 \u0434\u043E 140 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
    await env.DB.batch([stmt2(env, "UPDATE photo_tags SET comment=? WHERE id=?", comment, tag.id), notice(env, stmt2, p.author, m.id, "tag_comment", tag.id, p.id)]);
    return json({ ok: true });
  }
  return null;
}
async function postTagCommands(env, c, author, pid, media, depth, excluded, global, tags) {
  if (tags === void 0) return [];
  if (!Array.isArray(tags) || tags.length > 30) fail(400, "\u0414\u043E 30 \u043E\u0442\u043C\u0435\u0442\u043E\u043A \u043D\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E");
  if (!tags.length) return [c.stmt(env, "DELETE FROM photo_tags WHERE post=?", pid)];
  const photos = new Set((await c.rows(env, `SELECT id FROM media WHERE id IN (${media.map(() => "?").join(",") || "NULL"}) AND type LIKE 'image/%'`, ...media)).map((p) => p.id));
  const { people, graph } = await c.network(env, author), members = new Set(people.map((p) => p.id)), seen = /* @__PURE__ */ new Set(), existing = await c.rows(env, "SELECT * FROM photo_tags WHERE post=?", pid), commands = [c.stmt(env, "DELETE FROM photo_tags WHERE post=?", pid)];
  for (const t of tags) {
    if (!t || !photos.has(t.mediaId) || !members.has(t.member) || !Number.isFinite(t.x) || !Number.isFinite(t.y) || t.x < 0 || t.x > 1 || t.y < 0 || t.y > 1) fail(400, "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043E\u0442\u043C\u0435\u0442\u043A\u0438 \u043D\u0430 \u0444\u043E\u0442\u043E");
    const key = t.mediaId + ":" + t.member;
    if (seen.has(key)) fail(400, "\u041E\u0434\u0438\u043D \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u2014 \u043E\u0434\u043D\u0430 \u043E\u0442\u043C\u0435\u0442\u043A\u0430 \u043D\u0430 \u0444\u043E\u0442\u043E");
    seen.add(key);
    if (t.member !== author && (excluded.includes(t.member) || !global && (!graph.has(t.member) || graph.get(t.member).depth > depth))) fail(400, "\u041E\u0442\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u0439 \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u0434\u043E\u043B\u0436\u0435\u043D \u0432\u0438\u0434\u0435\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E");
    const old = existing.find((x) => x.id === t.id && x.media === t.mediaId && x.member === t.member), id2 = old?.id || crypto.randomUUID();
    commands.push(c.stmt(env, "INSERT INTO photo_tags(id,post,media,member,x,y,comment,created) VALUES(?,?,?,?,?,?,?,?)", id2, pid, t.mediaId, t.member, Math.round(t.x * 1e4), Math.round(t.y * 1e4), old?.comment || "", old?.created || now()));
    if (!old) commands.push(notice(env, c.stmt, t.member, author, "photo_tag", id2, pid));
  }
  return commands;
}

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
  const body2 = concat(salt, record, new Uint8Array([65]), as, encrypted), header = b64(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))), claims = b64(enc.encode(JSON.stringify({ aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1e3) + 43200, sub: env.REEF_PUSH_SUBJECT }))), input = header + "." + claims, privateKey = await crypto.subtle.importKey("jwk", JSON.parse(env.REEF_VAPID_PRIVATE), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]), signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(input));
  return { body: body2, headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", "authorization": "vapid t=" + input + "." + b64(signature) + ", k=" + env.REEF_VAPID_PUBLIC, ttl: "86400", urgency: "high" } };
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
  const now7 = Math.floor(Date.now() / 1e3);
  await env.DB.prepare("UPDATE notifications SET pushed=0 WHERE pushed=2 AND (push_claimed IS NULL OR push_claimed<?)").bind(now7 - 60).run();
  await env.DB.prepare("UPDATE notifications SET pushed=1 WHERE pushed=0 AND NOT EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.member=notifications.recipient)").run();
  const found = (await env.DB.prepare("SELECT n.id,n.recipient,n.kind,n.push_attempts,m.name FROM notifications n JOIN members m ON m.id=n.actor WHERE n.pushed=0 AND n.push_attempts<6 AND n.next_push<=? ORDER BY n.created DESC LIMIT 10").bind(now7).all()).results;
  const labels = { like: "\u043E\u0446\u0435\u043D\u0438\u043B(\u0430) \u0432\u0430\u0448\u0443 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E", comment: "\u043F\u0440\u043E\u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043B(\u0430) \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E", reply: "\u043E\u0442\u0432\u0435\u0442\u0438\u043B(\u0430) \u043D\u0430 \u0432\u0430\u0448 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439", comment_like: "\u043E\u0446\u0435\u043D\u0438\u043B(\u0430) \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439", friend: "\u0442\u0435\u043F\u0435\u0440\u044C \u0443 \u0432\u0430\u0441 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F\u0445", friend_request: "\u0445\u043E\u0447\u0435\u0442 \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0432\u0430\u0441 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F", invite_joined: "\u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043B\u0441\u044F(\u0430\u0441\u044C) \u043F\u043E \u0432\u0430\u0448\u0435\u043C\u0443 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044E", message: "\u043E\u0442\u043F\u0440\u0430\u0432\u0438\u043B(\u0430) \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435", photo_tag: "\u043E\u0442\u043C\u0435\u0442\u0438\u043B(\u0430) \u0432\u0430\u0441 \u043D\u0430 \u0444\u043E\u0442\u043E", tag_comment: "\u043E\u0441\u0442\u0430\u0432\u0438\u043B(\u0430) \u043F\u043E\u0434\u043F\u0438\u0441\u044C \u043D\u0430 \u0444\u043E\u0442\u043E" };
  await Promise.all(found.map(async (n) => {
    const claim = await env.DB.prepare("UPDATE notifications SET pushed=2,push_claimed=?,push_attempts=push_attempts+1 WHERE id=? AND pushed=0 RETURNING id").bind(now7, n.id).first();
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
    await env.DB.prepare("UPDATE notifications SET pushed=?,next_push=?,push_claimed=NULL WHERE id=?").bind(retry ? 0 : 1, retry ? now7 + Math.min(300, 5 * 2 ** n.push_attempts) : 0, n.id).run();
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
    const id2 = await hash(d.endpoint), existing = await c.one(env, "SELECT id FROM push_subscriptions WHERE id=? AND member=?", id2, m.id);
    if (!existing && (await c.one(env, "SELECT count(*) AS n FROM push_subscriptions WHERE member=?", m.id)).n >= 10) fail(400, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D\u043D\u044B\u0445 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432");
    if (!existing) await c.stmt(env, "UPDATE notifications SET pushed=1 WHERE recipient=? AND pushed=0 AND NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE member=?)", m.id, m.id).run();
    await c.stmt(env, "INSERT INTO push_subscriptions(id,member,endpoint,p256dh,auth,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET member=excluded.member,p256dh=excluded.p256dh,auth=excluded.auth", id2, m.id, d.endpoint, d.keys.p256dh, d.keys.auth, Math.floor(Date.now() / 1e3)).run();
    return json({ ok: true });
  }
  if (path === "/reef-api/push/subscription" && request.method === "DELETE") {
    const d = await c.body(request, 4e3);
    await c.stmt(env, "DELETE FROM push_subscriptions WHERE id=? AND member=?", await hash(String(d.endpoint)), m.id).run();
    return json({ ok: true });
  }
  return null;
}

// worker/social.mjs
var now2 = () => Math.floor(Date.now() / 1e3);
async function social(request, env, m, c) {
  const { stmt: stmt2, one: one2, rows: rows2, body: body2, rate: rate2, readPost: readPost2, bounded: bounded2 } = c, url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/reef-api/updates") {
    const [notifications, messages, friends, requests] = await Promise.all([one2(env, "SELECT count(*) AS n FROM notifications WHERE recipient=? AND seen=0", m.id), one2(env, "SELECT count(*) AS n FROM messages WHERE recipient=? AND seen=0", m.id), rows2(env, "SELECT n.id,n.actor,m.name,m.avatar_id FROM notifications n JOIN members m ON m.id=n.actor WHERE n.recipient=? AND n.kind IN ('friend','invite_joined') ORDER BY n.created DESC,n.id DESC LIMIT 12", m.id), one2(env, "SELECT count(*) AS n FROM friend_requests WHERE recipient=?", m.id)]);
    const events = await rows2(env, "SELECT n.id,n.kind,n.actor,n.post,n.created,m.name,m.avatar_id FROM notifications n JOIN members m ON m.id=n.actor WHERE n.recipient=? ORDER BY n.rowid DESC LIMIT 10", m.id);
    const activeEvents = await enrichPeople(env, events), activeFriends = await enrichPeople(env, friends);
    return json({ feedMode: m.feed_mode, events: activeEvents.map((p) => ({ ...p, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null })), requests: requests.n, unread: notifications.n, messages: messages.n, friends: activeFriends.map((p) => ({ ...p, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null })) });
  }
  if (path === "/reef-api/notifications" && method === "GET") {
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const list = await rows2(env, "SELECT n.rowid AS seq,n.*,m.name,m.avatar_id FROM notifications n JOIN members m ON m.id=n.actor WHERE recipient=? AND n.rowid<? ORDER BY n.rowid DESC LIMIT 41", m.id, before), page = list.slice(0, 40), safe = [];
    for (const n of page) {
      if (n.kind === "friend_request" && !await one2(env, "SELECT sender FROM friend_requests WHERE sender=? AND recipient=?", n.actor, m.id)) continue;
      if (n.post) {
        try {
          await readPost2(env, m.id, n.post);
        } catch {
          continue;
        }
      }
      safe.push({ ...n, avatar: n.avatar_id ? "/media/" + n.avatar_id + "?thumb=1" : null });
    }
    return json({ notifications: await enrichPeople(env, safe), next: list.length > 40 ? page.at(-1).seq : null });
  }
  if (path === "/reef-api/notifications/read" && method === "POST") {
    const d = await body2(request);
    if (d.all === true) await stmt2(env, "UPDATE notifications SET seen=1 WHERE recipient=? AND seen=0", m.id).run();
    else {
      if (!Array.isArray(d.ids) || d.ids.length > 100 || d.ids.some((x) => typeof x !== "string")) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
      if (d.ids.length) await stmt2(env, `UPDATE notifications SET seen=1 WHERE recipient=? AND id IN (${d.ids.map(() => "?").join(",")})`, m.id, ...d.ids).run();
    }
    return json({ ok: true });
  }
  const cl = path.match(/^\/reef-api\/comments\/([^/]+)\/likes$/);
  if (cl && method === "PUT") {
    const comment = await one2(env, "SELECT * FROM comments WHERE id=?", cl[1]);
    if (!comment) fail(404, "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    await readPost2(env, m.id, comment.post);
    const d = await body2(request);
    if (typeof d.liked !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
    const commands = [stmt2(env, d.liked ? "INSERT OR IGNORE INTO comment_likes(comment,member) VALUES (?,?)" : "DELETE FROM comment_likes WHERE comment=? AND member=?", comment.id, m.id)];
    if (d.liked && !await one2(env, "SELECT member FROM comment_likes WHERE comment=? AND member=?", comment.id, m.id)) commands.push(notice(env, stmt2, comment.member, m.id, "comment_like", comment.id, comment.post));
    await env.DB.batch(commands);
    return json({ likes: (await one2(env, "SELECT count(*) AS n FROM comment_likes WHERE comment=?", comment.id)).n, liked: d.liked });
  }
  const pm = path.match(/^\/reef-api\/posts\/([^/]+)\/(likes|comments)$/);
  if (pm) {
    const p = await readPost2(env, m.id, pm[1]);
    if (pm[2] === "likes" && method === "PUT") {
      const d = await body2(request);
      if (typeof d.liked !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
      const commands = [stmt2(env, d.liked ? "INSERT OR IGNORE INTO likes(post,member) VALUES (?,?)" : "DELETE FROM likes WHERE post=? AND member=?", p.id, m.id)];
      if (d.liked && !await one2(env, "SELECT member FROM likes WHERE post=? AND member=?", p.id, m.id)) commands.push(notice(env, stmt2, p.author, m.id, "like", p.id, p.id));
      await env.DB.batch(commands);
      return json({ ok: true });
    }
    if (pm[2] === "comments" && method === "GET") return json({ comments: await enrichComments(env, await rows2(env, "SELECT c.id,c.text,c.created,c.member,m.name,m.role,m.avatar_id,(SELECT count(*) FROM comment_likes l WHERE l.comment=c.id) AS likes,EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment=c.id AND l.member=?) AS liked FROM comments c JOIN members m ON m.id=c.member WHERE c.post=? ORDER BY c.created ASC,c.id ASC LIMIT 150", m.id, p.id)) });
    if (pm[2] === "comments" && method === "POST") {
      await rate2(env, "comments:" + m.id, 60);
      const d = await body2(request), text = String(d.text || "").trim();
      if (!text || text.length > 1e3) fail(400, "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u2014 \u043E\u0442 1 \u0434\u043E 1000 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
      const id2 = crypto.randomUUID();
      await env.DB.batch([stmt2(env, "INSERT INTO comments(id,post,member,text,created) VALUES (?,?,?,?,?)", id2, p.id, m.id, text, now2()), notice(env, stmt2, p.author, m.id, "comment", id2, p.id)]);
      return json({ ok: true }, 201);
    }
  }
  if (path === "/reef-api/admin" && method === "GET") {
    if (!isAdmin(m)) fail(403, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443");
    const q = String(url.searchParams.get("q") || "").slice(0, 100), after = String(url.searchParams.get("after") || "");
    const [users, stats] = await Promise.all([rows2(env, "SELECT m.id,m.name,m.email,m.role,m.feed_mode,m.invite_limit,(SELECT count(*) FROM invites i WHERE i.inviter=m.id AND i.claimed_by IS NOT NULL) AS used FROM members m WHERE m.id>? AND (?='' OR instr(lower(m.name||' '||m.email),lower(?))>0) ORDER BY m.id LIMIT 31", after, q, q), one2(env, "SELECT (SELECT count(*) FROM members) AS members,(SELECT count(*) FROM posts) AS posts,(SELECT count(*) FROM media) AS files,(SELECT coalesce(sum(size),0) FROM media) AS bytes")]);
    return json({ users: users.slice(0, 30), next: users.length > 30 ? users[29].id : null, stats });
  }
  const adm = path.match(/^\/reef-api\/admin\/members\/([^/]+)\/(quota|invite|sessions)$/);
  if (adm && method === "POST") {
    if (!isAdmin(m)) fail(403, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443");
    const user = await one2(env, "SELECT id,name,role,invite_limit FROM members WHERE id=?", adm[1]);
    if (!user) fail(404, "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    if (adm[2] === "sessions") {
      if (user.id === m.id) fail(400, "\u0414\u043B\u044F \u0441\u0432\u043E\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \xAB\u0412\u044B\u0439\u0442\u0438\xBB");
      if (isAdmin(user) && m.role !== "owner") fail(403, "\u0422\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u0435\u0446 \u043C\u043E\u0436\u0435\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0430\u0442\u044C \u0441\u0435\u0430\u043D\u0441\u044B \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u043E\u0432");
      await env.DB.batch([stmt2(env, "DELETE FROM sessions WHERE member=?", user.id), stmt2(env, "DELETE FROM push_subscriptions WHERE member=?", user.id)]);
      return json({ ok: true });
    }
    if (adm[2] === "quota") {
      const d = await body2(request);
      if (!Number.isInteger(d.add) || d.add < 1 || d.add > 100) fail(400, "\u041C\u043E\u0436\u043D\u043E \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043E\u0442 1 \u0434\u043E 100 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0439");
      await stmt2(env, "UPDATE members SET invite_limit=invite_limit+? WHERE id=?", d.add, user.id).run();
      return json({ ok: true });
    }
    await stmt2(env, "UPDATE members SET invite_limit=invite_limit+1 WHERE id=?", user.id).run();
    return json(await createInvitation(env, stmt2, user.id, url.origin), 201);
  }
  if (path === "/reef-api/uploads" && method === "POST") {
    await rate2(env, "upload:" + m.id, 100, 86400);
    const d = await body2(request);
    if (!Number.isInteger(d.size) || d.size < 1 || d.size > 250 * 1024 * 1024 || !["video/mp4", "video/webm", "video/quicktime"].includes(d.type)) fail(400, "\u0412\u0438\u0434\u0435\u043E \u2014 \u0434\u043E 250 \u041C\u0411, MP4, MOV \u0438\u043B\u0438 WebM");
    const id2 = crypto.randomUUID(), upload = await env.BUCKET.createMultipartUpload(id2, { httpMetadata: { contentType: d.type } });
    await stmt2(env, "INSERT INTO uploads(id,owner,upload_id,size,type,width,height,expires) VALUES(?,?,?,?,?,?,?,?)", id2, m.id, upload.uploadId, d.size, d.type, Number.isInteger(d.width) ? d.width : null, Number.isInteger(d.height) ? d.height : null, now2() + 6 * 3600).run();
    return json({ id: id2, partSize: 5 * 1024 * 1024 }, 201);
  }
  const up = path.match(/^\/reef-api\/uploads\/([^/]+)\/(part|complete)$/);
  if (up) {
    const job = await one2(env, "SELECT * FROM uploads WHERE id=? AND owner=?", up[1], m.id);
    if (!job || job.expires < now2()) fail(404, "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0438\u0441\u0442\u0435\u043A\u043B\u0430. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0438\u0434\u0435\u043E \u0441\u043D\u043E\u0432\u0430.");
    const partSize = 5 * 1024 * 1024, count = Math.ceil(job.size / partSize);
    if (up[2] === "part" && method === "PUT") {
      if (job.completed) fail(409, "\u0412\u0438\u0434\u0435\u043E \u0443\u0436\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E");
      const number = Number(url.searchParams.get("number"));
      if (!Number.isInteger(number) || number < 1 || number > count) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0447\u0430\u0441\u0442\u044C");
      const expected = number === count ? job.size - partSize * (count - 1) : partSize, bytes = await bounded2(request, partSize);
      if (bytes.length !== expected) fail(400, "\u0420\u0430\u0437\u043C\u0435\u0440 \u0447\u0430\u0441\u0442\u0438 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u0435\u0442");
      if (number === 1) {
        const type = videoType(bytes);
        if (!type) fail(400, "\u0424\u0430\u0439\u043B \u043D\u0435 \u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u043C \u0432\u0438\u0434\u0435\u043E");
        await stmt2(env, "UPDATE uploads SET type=? WHERE id=?", type, job.id).run();
      }
      const upload = env.BUCKET.resumeMultipartUpload(job.id, job.upload_id), part = await upload.uploadPart(number, bytes);
      await stmt2(env, "INSERT INTO upload_parts(upload,part,etag,size) VALUES (?,?,?,?) ON CONFLICT(upload,part) DO UPDATE SET etag=excluded.etag,size=excluded.size", job.id, number, part.etag, bytes.length).run();
      return json({ ok: true });
    }
    if (up[2] === "complete" && method === "POST") {
      if (!job.completed) {
        const parts = await rows2(env, "SELECT part AS partNumber,etag,size FROM upload_parts WHERE upload=? ORDER BY part", job.id);
        if (parts.length !== count || parts.reduce((n, p) => n + p.size, 0) !== job.size) fail(409, "\u041D\u0435 \u0432\u0441\u0435 \u0447\u0430\u0441\u0442\u0438 \u0432\u0438\u0434\u0435\u043E \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u044B");
        await env.BUCKET.resumeMultipartUpload(job.id, job.upload_id).complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
        await env.DB.batch([stmt2(env, "INSERT OR IGNORE INTO media(id,owner,type,size,width,height,created) VALUES(?,?,?,?,?,?,?)", job.id, m.id, job.type, job.size, job.width, job.height, now2()), stmt2(env, "UPDATE uploads SET completed=1 WHERE id=?", job.id)]);
      }
      return json({ id: job.id, type: job.type, url: "/media/" + job.id, thumbnail: null, width: job.width, height: job.height });
    }
  }
  const thumb = path.match(/^\/reef-api\/media\/([^/]+)\/thumbnail$/);
  if (thumb && method === "PUT") {
    if (!await one2(env, "SELECT id FROM media WHERE id=? AND owner=?", thumb[1], m.id)) fail(404, "\u0424\u0430\u0439\u043B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    const bytes = await bounded2(request, 256 * 1024), type = imageType(bytes);
    if (!type) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u043F\u0440\u0435\u0432\u044C\u044E");
    await env.BUCKET.put(thumb[1] + "/thumb", bytes, { httpMetadata: { contentType: type } });
    await stmt2(env, "UPDATE media SET thumbnail=1 WHERE id=?", thumb[1]).run();
    return json({ url: "/media/" + thumb[1] + "?thumb=1" });
  }
  return null;
}

// worker/polls.mjs
function validatePoll(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 6 || value.some((x) => typeof x !== "string" || !x.trim() || x.trim().length > 100) || new Set(value.map((x) => x.trim().toLowerCase())).size !== value.length) fail(400, "\u041E\u043F\u0440\u043E\u0441: \u043E\u0442 2 \u0434\u043E 6 \u0440\u0430\u0437\u043D\u044B\u0445 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u043E\u0432, \u0434\u043E 100 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432 \u043A\u0430\u0436\u0434\u044B\u0439");
  return value.map((x) => x.trim());
}
async function pollsFor(env, ids, viewer) {
  const map = /* @__PURE__ */ new Map();
  if (!ids.length) return map;
  const marks = ids.map(() => "?").join(","), posts = (await env.DB.prepare(`SELECT id,poll FROM posts WHERE id IN (${marks}) AND poll IS NOT NULL`).bind(...ids).all()).results;
  if (!posts.length) return map;
  const votes = (await env.DB.prepare(`SELECT post,option,count(*) AS count,max(CASE WHEN member=? THEN 1 ELSE 0 END) AS mine FROM poll_votes WHERE post IN (${marks}) GROUP BY post,option`).bind(viewer, ...ids).all()).results;
  for (const p of posts) {
    const options = JSON.parse(p.poll), results = votes.filter((v) => v.post === p.id);
    map.set(p.id, { options: options.map((text, i) => ({ text, votes: results.find((v) => v.option === i)?.count || 0 })), total: results.reduce((sum, v) => sum + v.count, 0), selected: results.find((v) => v.mine)?.option ?? null });
  }
  return map;
}
async function pollApi(request, env, m, c) {
  const match = new URL(request.url).pathname.match(/^\/reef-api\/posts\/([^/]+)\/vote$/);
  if (!match || request.method !== "PUT") return null;
  const post = await c.readPost(env, m.id, match[1]);
  if (!post.poll) fail(404, "\u041E\u043F\u0440\u043E\u0441 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  const options = JSON.parse(post.poll), d = await c.body(request);
  if (!Number.isInteger(d.option) || d.option < 0 || d.option >= options.length) fail(400, "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442 \u043E\u0442\u0432\u0435\u0442\u0430");
  await c.stmt(env, "INSERT INTO poll_votes(post,member,option) VALUES(?,?,?) ON CONFLICT(post,member) DO UPDATE SET option=excluded.option", post.id, m.id, d.option).run();
  return json({ poll: (await pollsFor(env, [post.id], m.id)).get(post.id) });
}

// worker/experience.mjs
var now3 = () => Math.floor(Date.now() / 1e3);
async function experience(request, env, m, c) {
  const path = new URL(request.url).pathname, url = new URL(request.url), method = request.method;
  if (path.startsWith("/reef-api/uploads/")) fail(410, "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043D\u043E\u0432\u044B\u0445 \u0432\u0438\u0434\u0435\u043E \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0430");
  if (path === "/reef-api/uploads") fail(410, "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043D\u043E\u0432\u044B\u0445 \u0432\u0438\u0434\u0435\u043E \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0430");
  if (path === "/reef-api/presence" && method === "POST" || path === "/reef-api/presence/offline" && method === "POST") {
    const token = request.headers.get("cookie")?.match(/(?:^|;\s*)__Host-reef=([A-Za-z0-9_-]+)/)?.[1];
    if (!m.invisible) await c.stmt(env, "UPDATE members SET last_active=? WHERE id=?", now3(), m.id).run();
    if (token) await c.stmt(env, "UPDATE sessions SET last_seen=? WHERE hash=? AND member=?", path.endsWith("offline") ? 0 : now3(), await hash(token), m.id).run();
    return json({ ok: true });
  }
  const mode = path.match(/^\/reef-api\/admin\/members\/([^/]+)\/feed-mode$/);
  if (mode && method === "POST") {
    if (!isAdmin(m)) fail(403, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443");
    const d = await c.body(request);
    if (!["normal", "screen"].includes(d.mode)) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0432\u0438\u0434 \u043B\u0435\u043D\u0442\u044B");
    const result = await c.stmt(env, "UPDATE members SET feed_mode=? WHERE id=?", d.mode, mode[1]).run();
    if (!result.meta.changes) fail(404, "\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    return json({ ok: true, mode: d.mode });
  }
  const presence = path.match(/^\/reef-api\/profiles\/([^/]+)\/presence$/);
  if (presence) {
    const exists = await c.one(env, "SELECT id,invisible,last_active FROM members WHERE id=?", presence[1]);
    if (!exists) fail(404, "\u041F\u0440\u043E\u0444\u0438\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    const active = await c.one(env, "SELECT max(last_seen) AS seen FROM sessions WHERE member=? AND expires>?", presence[1], now3());
    return json({ online: !exists.invisible && !!active.seen && active.seen >= now3() - 70, lastSeen: exists.invisible ? null : exists.last_active });
  }
  const friends = path.match(/^\/reef-api\/profiles\/([^/]+)\/friends$/);
  if (friends && method === "GET") {
    const uid = friends[1];
    if (!await c.one(env, "SELECT id FROM members WHERE id=?", uid)) fail(404, "\u041F\u0440\u043E\u0444\u0438\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    const after = String(url.searchParams.get("after") || ""), data = await c.rows(env, "SELECT u.id,u.name,u.avatar_id,u.role,u.invisible,u.last_active,EXISTS(SELECT 1 FROM sessions s WHERE s.member=u.id AND s.expires>? AND s.last_seen>=?) AS online FROM friends f JOIN members u ON u.id=CASE WHEN f.a=? THEN f.b ELSE f.a END WHERE (f.a=? OR f.b=?) AND u.id>? ORDER BY u.id LIMIT 31", now3(), now3() - 70, uid, uid, uid, after);
    return json({ friends: data.slice(0, 30).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null, online: !p.invisible && !!p.online, lastSeen: p.invisible ? null : p.last_active })), next: data.length > 30 ? data[29].id : null });
  }
  if (path === "/reef-api/settings" && method === "PUT") {
    const d = await c.body(request);
    if (typeof d.invisible !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430");
    await c.stmt(env, "UPDATE members SET invisible=? WHERE id=?", d.invisible ? 1 : 0, m.id).run();
    return json({ invisible: d.invisible });
  }
  const reaction = path.match(/^\/reef-api\/messages\/([^/]+)\/like$/);
  if (reaction && method === "PUT") {
    const msg = await c.one(env, "SELECT sender,recipient FROM messages WHERE id=?", reaction[1]);
    if (!msg || ![msg.sender, msg.recipient].includes(m.id)) fail(404, "\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
    const d = await c.body(request);
    if (typeof d.liked !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0440\u0435\u0430\u043A\u0446\u0438\u044F");
    await c.stmt(env, d.liked ? "INSERT OR IGNORE INTO message_likes(message,member) VALUES(?,?)" : "DELETE FROM message_likes WHERE message=? AND member=?", reaction[1], m.id).run();
    return json({ liked: d.liked, likes: (await c.one(env, "SELECT count(*) AS n FROM message_likes WHERE message=?", reaction[1])).n });
  }
  return null;
}

// worker/live.mjs
async function live(request, env, m, c) {
  const path = new URL(request.url).pathname;
  if (path !== "/reef-api/live" || request.method !== "POST") return null;
  const d = await c.body(request, 8e3);
  if (!Array.isArray(d.posts) || d.posts.length > 12 || d.posts.some((id2) => typeof id2 !== "string" || id2.length > 100) || !Array.isArray(d.comments) || d.comments.length > 4 || d.comments.some((id2) => !d.posts.includes(id2))) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F");
  const ids = [...new Set(d.posts)];
  if (!ids.length) return json({ posts: [], comments: {}, unavailable: [] });
  const { graph } = await c.network(env, m.id), found = await c.rows(env, `SELECT p.*,${onlineSQL("u")} AS online,(SELECT count(*) FROM likes l WHERE l.post=p.id) AS likes,(SELECT count(*) FROM comments x WHERE x.post=p.id) AS comment_count,EXISTS(SELECT 1 FROM likes l WHERE l.post=p.id AND l.member=?) AS liked FROM posts p JOIN members u ON u.id=p.author WHERE p.id IN (${ids.map(() => "?").join(",")}) AND NOT EXISTS(SELECT 1 FROM exclusions e WHERE e.post=p.id AND e.member=? AND p.author<>?)`, m.id, ...ids, m.id, m.id), permitted = found.filter((p) => canRead(p, m.id, graph)), allowed = new Set(permitted.map((p) => p.id)), comments = {};
  for (const id2 of d.comments.filter((id3) => allowed.has(id3))) comments[id2] = await commentsFor(env, c, m.id, id2);
  const commentAccess = /* @__PURE__ */ new Map();
  for (const p of permitted) commentAccess.set(p.id, await commentPermission(env, c, m.id, p));
  const tags = await tagsFor(env, permitted.map((p) => p.id));
  const polls = await pollsFor(env, permitted.map((p) => p.id), m.id);
  return json({ posts: permitted.map((p) => ({ id: p.id, canComment: commentAccess.get(p.id), online: !!p.online, tags: tags.get(p.id) || [], poll: polls.get(p.id) || null, likes: p.likes, liked: !!p.liked, commentCount: p.comment_count })), comments, unavailable: ids.filter((id2) => !allowed.has(id2)) });
}

// worker/friendship.mjs
var now4 = () => Math.floor(Date.now() / 1e3);
async function friendship(request, env, m, c) {
  const { one: one2, rows: rows2, stmt: stmt2, body: body2, rate: rate2 } = c, path = new URL(request.url).pathname, method = request.method;
  const person = async (uid) => {
    const p = await one2(env, "SELECT id,name,avatar_id FROM members WHERE id=?", uid);
    return p ? { id: p.id, name: p.name, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null } : null;
  };
  const pendingNotice = (recipient, actor) => stmt2(env, "INSERT OR IGNORE INTO notifications(id,recipient,actor,kind,target,created) VALUES(?,?,?,'friend_request',?,?)", "friend_request:" + recipient + ":" + actor + ":" + actor, recipient, actor, actor, now4());
  const clearPending = (a, b) => stmt2(env, "DELETE FROM notifications WHERE kind='friend_request' AND ((recipient=? AND actor=?) OR (recipient=? AND actor=?))", a, b, b, a);
  if (path === "/reef-api/friend-requests" && method === "GET") {
    const [incoming, outgoing] = await Promise.all([rows2(env, "SELECT m.id,m.name,m.avatar_id,r.created FROM friend_requests r JOIN members m ON m.id=r.sender WHERE r.recipient=? ORDER BY r.created DESC LIMIT 100", m.id), rows2(env, "SELECT m.id,m.name,m.avatar_id,r.created FROM friend_requests r JOIN members m ON m.id=r.recipient WHERE r.sender=? ORDER BY r.created DESC LIMIT 100", m.id)]);
    const shape = (p) => ({ id: p.id, name: p.name, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null, created: p.created });
    return json({ incoming: await enrichPeople(env, incoming.map(shape)), outgoing: await enrichPeople(env, outgoing.map(shape)) });
  }
  if (path === "/reef-api/friends" && method === "POST") {
    const d = await body2(request);
    if (typeof d.member !== "string" || d.member === m.id || !await person(d.member)) fail(404, "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    if (await one2(env, "SELECT a FROM friends WHERE a=min(?,?) AND b=max(?,?)", m.id, d.member, m.id, d.member)) return json({ ok: true, status: "friends" });
    await rate2(env, "friend-requests:" + m.id, 30, 86400);
    await env.DB.batch([stmt2(env, "INSERT OR IGNORE INTO friend_requests(a,b,sender,recipient,created) VALUES(min(?,?),max(?,?),?,?,?)", m.id, d.member, m.id, d.member, m.id, d.member, now4()), stmt2(env, "INSERT OR IGNORE INTO notifications(id,recipient,actor,kind,target,created) SELECT ?,?,?,'friend_request',?,? WHERE EXISTS(SELECT 1 FROM friend_requests WHERE sender=? AND recipient=?)", "friend_request:" + d.member + ":" + m.id + ":" + m.id, d.member, m.id, m.id, now4(), m.id, d.member)]);
    const pending = await one2(env, "SELECT sender FROM friend_requests WHERE a=min(?,?) AND b=max(?,?)", m.id, d.member, m.id, d.member);
    return json({ ok: true, status: pending.sender === m.id ? "outgoing" : "incoming" });
  }
  const requestPath = path.match(/^\/reef-api\/friend-requests\/([^/]+)(?:\/(accept|decline))?$/);
  if (requestPath) {
    const uid = requestPath[1], action = requestPath[2];
    if (uid === m.id) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A");
    if (method === "DELETE" && !action) {
      await env.DB.batch([stmt2(env, "DELETE FROM friend_requests WHERE sender=? AND recipient=?", m.id, uid), stmt2(env, "DELETE FROM notifications WHERE kind='friend_request' AND recipient=? AND actor=?", uid, m.id)]);
      return json({ ok: true });
    }
    if (method === "POST" && action) {
      const pending = await one2(env, "SELECT sender FROM friend_requests WHERE sender=? AND recipient=?", uid, m.id);
      if (!pending) fail(404, "\u0417\u0430\u044F\u0432\u043A\u0430 \u0443\u0436\u0435 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u0430 \u0438\u043B\u0438 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430");
      if (action === "decline") {
        await env.DB.batch([stmt2(env, "DELETE FROM friend_requests WHERE sender=? AND recipient=?", uid, m.id), clearPending(m.id, uid)]);
        return json({ ok: true });
      }
      const notify = (recipient, actor) => stmt2(env, "INSERT OR IGNORE INTO notifications(id,recipient,actor,kind,target,created) SELECT ?,?,?,'friend',?,? WHERE EXISTS(SELECT 1 FROM friend_requests WHERE sender=? AND recipient=?)", "friend:" + recipient + ":" + actor + ":" + actor, recipient, actor, actor, now4(), uid, m.id);
      const result = await env.DB.batch([stmt2(env, "INSERT OR IGNORE INTO friends(a,b,created) SELECT min(?,?),max(?,?),? WHERE EXISTS(SELECT 1 FROM friend_requests WHERE sender=? AND recipient=?)", m.id, uid, m.id, uid, now4(), uid, m.id), notify(m.id, uid), notify(uid, m.id), stmt2(env, "DELETE FROM friend_requests WHERE a=min(?,?) AND b=max(?,?)", m.id, uid, m.id, uid), clearPending(m.id, uid)]);
      if (!result[0].meta.changes) fail(409, "\u0417\u0430\u044F\u0432\u043A\u0430 \u0443\u0436\u0435 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u0430");
      return json({ ok: true, friend: await person(uid) });
    }
  }
  const removal = path.match(/^\/reef-api\/friends\/([^/]+)$/);
  if (removal && method === "DELETE") {
    const uid = removal[1];
    await env.DB.batch([stmt2(env, "DELETE FROM friends WHERE a=min(?,?) AND b=max(?,?)", m.id, uid, m.id, uid), stmt2(env, "DELETE FROM friend_requests WHERE a=min(?,?) AND b=max(?,?)", m.id, uid, m.id, uid), clearPending(m.id, uid), stmt2(env, "DELETE FROM notifications WHERE kind='friend' AND ((recipient=? AND actor=?) OR (recipient=? AND actor=?))", m.id, uid, uid, m.id)]);
    return json({ ok: true });
  }
  return null;
}

// worker/features.mjs
var now5 = () => Math.floor(Date.now() / 1e3);
var uuid = () => crypto.randomUUID();
async function features(request, env, m, c) {
  const { stmt: stmt2, one: one2, rows: rows2, body: body2, rate: rate2, network: network2, readPost: readPost2 } = c;
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const communityResponse = await community(request, env, m, c);
  if (communityResponse) return communityResponse;
  const pollResponse = await pollApi(request, env, m, c);
  if (pollResponse) return pollResponse;
  const experienceResponse = await experience(request, env, m, c);
  if (experienceResponse) return experienceResponse;
  const customBadgeResponse = await badgeApi(request, env, m, c);
  if (customBadgeResponse) return customBadgeResponse;
  const subscriptionResponse = await pushApi(request, env, m, c);
  if (subscriptionResponse) return subscriptionResponse;
  const liveResponse = await live(request, env, m, c);
  if (liveResponse) return liveResponse;
  const relationResponse = await friendship(request, env, m, c);
  if (relationResponse) return relationResponse;
  const extra = await social(request, env, m, c);
  if (extra) return extra;
  const mediaShape = (x) => ({ id: x.id, type: x.type, url: "/media/" + x.id, thumbnail: x.thumbnail ? "/media/" + x.id + "?thumb=1" : x.type.startsWith("image/") ? "/media/" + x.id : null, width: x.width, height: x.height, kind: x.kind, duration: x.duration });
  async function attachments(pids) {
    if (!pids.length) return /* @__PURE__ */ new Map();
    const marks = pids.map(() => "?").join(",");
    const all = await rows2(env, `SELECT pm.post,m.*,pm.position FROM post_media pm JOIN media m ON m.id=pm.media WHERE pm.post IN (${marks}) UNION ALL SELECT p.id AS post,m.*,0 AS position FROM posts p JOIN media m ON m.id=p.media_id WHERE p.id IN (${marks}) AND NOT EXISTS(SELECT 1 FROM post_media pm WHERE pm.post=p.id) ORDER BY position`, ...pids, ...pids);
    const grouped = /* @__PURE__ */ new Map();
    for (const row of all) {
      if (!grouped.has(row.post)) grouped.set(row.post, []);
      grouped.get(row.post).push(mediaShape(row));
    }
    return grouped;
  }
  async function feed(profile = null) {
    const cursor = decodeCursor(url.searchParams.get("cursor")), snapshot = cursor?.snapshot || now5(), limit = Math.min(12, Math.max(1, Number(url.searchParams.get("limit")) || 8)), { people, graph } = await network2(env, m.id), names = new Map(people.map((p) => [p.id, p.name]));
    const relations = [...graph].map(([id2, g]) => ({ id: id2, depth: g.depth })), muted = profile ? [] : JSON.parse(m.muted);
    let where = `p.created<=? AND (? IS NULL OR p.author=?) AND (p.author=? OR p.global=1 OR (g.value IS NOT NULL AND json_extract(g.value,'$.depth')<=p.depth ${profile ? "" : "AND json_extract(g.value,'$.depth')<=?"})) AND NOT EXISTS(SELECT 1 FROM exclusions e WHERE e.post=p.id AND e.member=?) AND NOT EXISTS(SELECT 1 FROM json_each(?) hidden WHERE hidden.value=p.author)`;
    const args = [snapshot, profile, profile, m.id, ...profile ? [] : [m.depth], m.id, JSON.stringify(muted)];
    const sql = `WITH visible AS (SELECT p.rowid AS seq,p.*,u.name,u.role,u.avatar_id,${onlineSQL("u")} AS online,json_extract(g.value,'$.depth') AS degree FROM posts p JOIN members u ON u.id=p.author LEFT JOIN json_each(?) g ON json_extract(g.value,'$.id')=p.author WHERE ${where}), scored AS (SELECT *,-created AS score FROM visible) SELECT *, (SELECT count(*) FROM likes l WHERE l.post=scored.id) AS likes,(SELECT count(*) FROM comments c WHERE c.post=scored.id) AS comment_count,EXISTS(SELECT 1 FROM likes l WHERE l.post=scored.id AND l.member=?) AS liked FROM scored WHERE (? IS NULL OR score>? OR (score=? AND seq<?)) ORDER BY score ASC,seq DESC LIMIT ?`;
    const found = await rows2(env, sql, JSON.stringify(relations), ...args, m.id, cursor?.id || null, cursor?.score || 0, cursor?.score || 0, cursor?.seq ?? Number.MAX_SAFE_INTEGER, limit + 1), more = found.length > limit, selected = found.slice(0, limit), photos = await attachments(selected.map((p) => p.id));
    const postTags = await tagsFor(env, selected.map((p) => p.id)), hidden = /* @__PURE__ */ new Map(), ownIds = selected.filter((p) => p.author === m.id).map((p) => p.id);
    if (ownIds.length) {
      for (const e of await rows2(env, `SELECT e.post,u.id,u.name FROM exclusions e JOIN members u ON u.id=e.member WHERE e.post IN (${ownIds.map(() => "?").join(",")})`, ...ownIds)) {
        if (!hidden.has(e.post)) hidden.set(e.post, []);
        hidden.get(e.post).push({ id: e.id, name: e.name });
      }
    }
    const customBadges = await badgesFor(env, selected.map((p) => p.author));
    const polls = await pollsFor(env, selected.map((p) => p.id), m.id);
    const posts = selected.map((p) => {
      const g = graph.get(p.author);
      const via = g?.depth === 1 ? "\u0412\u0430\u0448 \u0434\u0440\u0443\u0433" : g?.depth === 2 ? "\u0414\u0440\u0443\u0433 " + names.get(g.path[1]) : g?.depth === 3 ? "\u0427\u0435\u0440\u0435\u0437 " + names.get(g.path[1]) + " \u0438 " + names.get(g.path[2]) : p.global ? "\u0414\u043B\u044F \u0432\u0441\u0435\u0445 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432" : "";
      return { id: p.id, commentPolicy: p.author === m.id ? commentPolicy(p) : null, canComment: p.author === m.id || !JSON.parse(p.comment_excluded || "[]").includes(m.id) && p.comment_depth !== 0 && (g?.depth ?? 4) <= (p.comment_depth ?? 4), tags: postTags.get(p.id) || [], hiddenFrom: hidden.get(p.id) || [], online: !!p.online, poll: polls.get(p.id) || null, author: p.author, name: p.name, badges: customBadges.get(p.author) || [], admin: ["owner", "admin"].includes(p.role), staffRole: ["owner", "admin", "moderator", "support"].includes(p.role) ? p.role : null, telegramVerified: false, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null, degree: g?.depth ?? null, via, created: p.created, updated: p.updated, text: p.text, photo: photos.get(p.id)?.[0]?.url || null, media: photos.get(p.id) || [], likes: p.likes, liked: !!p.liked, commentCount: p.comment_count, audience: p.depth, global: !!p.global };
    });
    const last = selected.at(-1);
    return json({ posts, next: more && last ? encodeCursor({ score: last.score, id: last.id, seq: last.seq, snapshot }) : null });
  }
  if (path === "/reef-api/audience" && url.searchParams.get("all") === "1") {
    if (!isAdmin(m)) fail(403, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443");
    return json({ people: (await rows2(env, "SELECT id,name FROM members WHERE id<>?", m.id)).map((p) => ({ ...p, degree: null })) });
  }
  if (path === "/reef-api/posts" && method === "GET") return feed();
  const profilePath = path.match(/^\/reef-api\/profiles\/([^/]+)(?:\/(posts))?$/);
  if (profilePath && method === "GET") {
    const uid = profilePath[1], person = await one2(env, "SELECT id,name,bio,avatar_id,role,invisible,last_active FROM members WHERE id=?", uid);
    if (!person) fail(404, "\u041F\u0440\u043E\u0444\u0438\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
    if (profilePath[2]) return feed(uid);
    const [net, edges] = await Promise.all([network2(env, m.id), rows2(env, "SELECT a,b FROM friends WHERE a IN (?,?) OR b IN (?,?)", m.id, uid, m.id, uid)]);
    const neighbours = (id2) => edges.filter((e) => e.a === id2 || e.b === id2).map((e) => e.a === id2 ? e.b : e.a);
    const mine = neighbours(m.id), theirs = neighbours(uid), mutual = net.people.filter((p) => mine.includes(p.id) && theirs.includes(p.id)), g = net.graph.get(uid);
    const chain = g?.path.slice(1).map((id2) => net.people.find((p) => p.id === id2)).filter(Boolean) || [];
    const pending = await one2(env, "SELECT sender,recipient FROM friend_requests WHERE a=min(?,?) AND b=max(?,?)", m.id, uid, m.id, uid);
    return json({ profile: { badges: (await badgesFor(env, [person.id])).get(person.id) || [], request: pending ? pending.sender === m.id ? "outgoing" : "incoming" : null, messagingAllowed: await canMessage(env, m.id, uid), lastSeen: person.invisible ? null : person.last_active, online: !person.invisible && !!await one2(env, "SELECT 1 AS active FROM sessions WHERE member=? AND expires>? AND last_seen>=? LIMIT 1", uid, now5(), now5() - 70), friendsCount: (await one2(env, "SELECT count(*) AS n FROM friends WHERE a=? OR b=?", uid, uid)).n, id: person.id, name: person.name, bio: person.bio, avatarId: person.avatar_id, avatar: person.avatar_id ? "/media/" + person.avatar_id + "?thumb=1" : null, admin: isAdmin(person), staffRole: ["owner", "admin", "moderator", "support"].includes(person.role) ? person.role : null, telegramVerified: false, own: uid === m.id, friend: mine.includes(uid), degree: g?.depth ?? null, mutual, chain } });
  }
  if (path === "/reef-api/profile" && method === "PUT") {
    const d = await body2(request), name = String(d.name || "").trim(), bio = String(d.bio || "").trim();
    if (name.length < 2 || name.length > 60 || bio.length > 240) fail(400, "\u0418\u043C\u044F \u2014 2\u201360 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432, \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u2014 \u0434\u043E 240");
    if (d.avatar && await one2(env, "SELECT id FROM comments WHERE media_id=?", d.avatar)) fail(400, "\u0410\u0432\u0430\u0442\u0430\u0440\u043A\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
    if (d.avatar && !await one2(env, "SELECT id FROM media WHERE id=? AND owner=? AND type LIKE 'image/%' AND NOT EXISTS(SELECT 1 FROM post_media WHERE media=?) AND NOT EXISTS(SELECT 1 FROM posts WHERE media_id=?)", d.avatar, m.id, d.avatar, d.avatar)) fail(400, "\u0410\u0432\u0430\u0442\u0430\u0440\u043A\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
    await stmt2(env, "UPDATE members SET name=?,bio=?,avatar_id=? WHERE id=?", name, bio, d.avatar || null, m.id).run();
    return json({ ok: true });
  }
  if (path === "/reef-api/friends" && method === "POST") {
    const d = await body2(request);
    if (d.member === m.id || typeof d.member !== "string" || !await one2(env, "SELECT id FROM members WHERE id=?", d.member)) fail(404, "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    if (await one2(env, "SELECT a FROM friends WHERE a=min(?,?) AND b=max(?,?)", m.id, d.member, m.id, d.member)) return json({ ok: true, added: false });
    const result = await env.DB.batch([stmt2(env, "INSERT OR IGNORE INTO friends(a,b,created) VALUES(min(?,?),max(?,?),?)", m.id, d.member, m.id, d.member, now5()), notice(env, stmt2, m.id, d.member, "friend", d.member), notice(env, stmt2, d.member, m.id, "friend", m.id)]);
    const friend = await one2(env, "SELECT id,name,avatar_id FROM members WHERE id=?", d.member);
    return json({ ok: true, added: !!result[0].meta.changes, friend: { ...friend, avatar: friend.avatar_id ? "/media/" + friend.avatar_id + "?thumb=1" : null } });
  }
  if (path === "/reef-api/invites" && method === "GET") {
    const count = await one2(env, "SELECT count(*) AS n FROM invites WHERE inviter=? AND claimed_by IS NOT NULL", m.id);
    return json({ used: count.n, limit: isAdmin(m) ? null : m.invite_limit, pending: await rows2(env, "SELECT hash AS id,expires FROM invites WHERE inviter=? AND claimed_by IS NULL AND expires>? ORDER BY created DESC", m.id, now5()) });
  }
  const revoke = path.match(/^\/reef-api\/invites\/([a-f0-9]{64})$/);
  if (revoke && method === "DELETE") {
    await stmt2(env, "DELETE FROM invites WHERE hash=? AND inviter=? AND claimed_by IS NULL", revoke[1], m.id).run();
    return json({ ok: true });
  }
  if (path === "/reef-api/invites" && method === "POST") {
    const token = randomToken(), expires = now5() + 7 * 86400;
    const result = await stmt2(env, `INSERT INTO invites(hash,inviter,expires,created) SELECT ?,?,?,? WHERE ? OR (SELECT count(*) FROM invites WHERE inviter=? AND claimed_by IS NOT NULL)<?`, await hash(token), m.id, expires, now5(), isAdmin(m) ? 1 : 0, m.id, m.invite_limit).run();
    if (!result.meta.changes) fail(403, "\u041B\u0438\u043C\u0438\u0442 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0439 \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D. \u041E\u0442\u0437\u043E\u0432\u0438\u0442\u0435 \u043D\u0435\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043D\u0443\u044E \u0441\u0441\u044B\u043B\u043A\u0443 \u0438\u043B\u0438 \u043E\u0431\u0440\u0430\u0442\u0438\u0442\u0435\u0441\u044C \u043A \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443.");
    return json({ url: url.origin + "/#invite=" + token, expires }, 201);
  }
  if (path === "/reef-api/messages" && method === "GET") {
    const data = await rows2(env, `WITH relevant AS(SELECT *,CASE WHEN sender=? THEN recipient ELSE sender END AS other FROM messages WHERE sender=? OR recipient=?), ranked AS(SELECT *,row_number() OVER(PARTITION BY other ORDER BY created DESC,id DESC) AS rn FROM relevant) SELECT r.id,r.text,r.created,r.other AS member,m.name,m.avatar_id,(SELECT count(*) FROM messages x WHERE x.sender=r.other AND x.recipient=? AND x.seen=0) AS unread FROM ranked r JOIN members m ON m.id=r.other WHERE rn=1 ORDER BY r.created DESC LIMIT 50`, m.id, m.id, m.id, m.id);
    return json({ chats: await enrichPeople(env, data.map((p) => ({ ...p, id: p.member, avatar: p.avatar_id ? "/media/" + p.avatar_id + "?thumb=1" : null }))) });
  }
  const chat = path.match(/^\/reef-api\/messages\/([^/]+)$/);
  if (chat) {
    const uid = chat[1];
    if (uid === m.id || !await one2(env, "SELECT id FROM members WHERE id=?", uid)) fail(404, "\u0421\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    if (method === "GET") {
      const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
      const msgs = await rows2(env, "SELECT id,sender,text,created,(SELECT count(*) FROM message_likes l WHERE l.message=messages.id) AS likes,EXISTS(SELECT 1 FROM message_likes l WHERE l.message=messages.id AND l.member=?) AS liked FROM messages WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND rowid<? ORDER BY rowid DESC LIMIT 51", m.id, m.id, uid, uid, m.id, before);
      const page = msgs.slice(0, 50);
      let next = null;
      if (msgs.length > 50) {
        const row = await one2(env, "SELECT rowid AS seq FROM messages WHERE id=?", page.at(-1).id);
        next = row.seq;
      }
      await stmt2(env, "UPDATE messages SET seen=1 WHERE sender=? AND recipient=? AND seen=0", uid, m.id).run();
      return json({ messages: page.reverse(), next });
    }
    if (method === "POST") {
      if (!await canMessage(env, m.id, uid)) fail(403, "\u0427\u0442\u043E\u0431\u044B \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443 \u0432\u043D\u0435 \u0434\u0440\u0443\u0437\u0435\u0439, \u043D\u0443\u0436\u0435\u043D \u0432\u0437\u0430\u0438\u043C\u043D\u044B\u0439 \u043B\u0430\u0439\u043A \u0438\u043B\u0438 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u043A \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F\u043C \u0434\u0440\u0443\u0433 \u0434\u0440\u0443\u0433\u0430.");
      await rate2(env, "messages:" + m.id, 60);
      const d = await body2(request), text = String(d.text || "").trim();
      if (!text || text.length > 2e3) fail(400, "\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u2014 \u043E\u0442 1 \u0434\u043E 2000 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
      const mid = uuid();
      await env.DB.batch([stmt2(env, "INSERT INTO messages(id,sender,recipient,text,created) VALUES (?,?,?,?,?)", mid, m.id, uid, text, now5()), notice(env, stmt2, uid, m.id, "message", mid)]);
      return json({ ok: true }, 201);
    }
  }
  const pm = path.match(/^\/reef-api\/posts\/([^/]+)$/);
  if (path === "/reef-api/posts" && method === "POST" || pm && method === "PUT") {
    if (method === "POST") await rate2(env, "posts:" + m.id, 100, 86400);
    const existing = pm ? await readPost2(env, m.id, pm[1]) : null;
    if (existing && existing.author !== m.id) fail(403, "\u041C\u043E\u0436\u043D\u043E \u043C\u0435\u043D\u044F\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0432\u043E\u0439 \u043F\u043E\u0441\u0442");
    const d = await body2(request, 64e3), text = typeof d.text === "string" ? d.text.trim() : "", media = d.mediaIds ?? (d.media ? [d.media] : []);
    if (!Array.isArray(media) || media.length > 10 || media.some((x) => typeof x !== "string") || new Set(media).size !== media.length || text.length > 5e3 || !text && !media.length || ![1, 2, 3].includes(d.depth) || !Array.isArray(d.excluded) || d.excluded.length > 200 || d.excluded.some((x) => typeof x !== "string")) fail(400, "\u0414\u043E 10 \u0444\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u0439, \u0442\u0435\u043A\u0441\u0442 \u0434\u043E 5000 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
    if (d.global && !isAdmin(m)) fail(403, "\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u0434\u043B\u044F \u0432\u0441\u0435\u0445 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443");
    const poll = d.poll === void 0 ? existing?.poll ? JSON.parse(existing.poll) : null : validatePoll(d.poll);
    if (poll && !text) fail(400, "\u041D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0432\u043E\u043F\u0440\u043E\u0441 \u0432 \u0442\u0435\u043A\u0441\u0442\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438");
    if (existing && JSON.stringify(poll) !== (existing.poll || "null") && (await one2(env, "SELECT count(*) AS n FROM poll_votes WHERE post=?", existing.id)).n) fail(400, "\u041D\u0435\u043B\u044C\u0437\u044F \u043C\u0435\u043D\u044F\u0442\u044C \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u044B \u043E\u043F\u0440\u043E\u0441\u0430 \u043F\u043E\u0441\u043B\u0435 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u0430\u043D\u0438\u044F");
    const pid = existing?.id || uuid();
    for (const mid of media) {
      const image = await one2(env, "SELECT * FROM media WHERE id=? AND owner=?", mid, m.id);
      if (image?.type.startsWith("video/") && image.kind !== "square" && (!existing || !await one2(env, "SELECT id FROM posts WHERE id=? AND media_id=? UNION SELECT post AS id FROM post_media WHERE post=? AND media=?", pid, mid, pid, mid))) fail(400, "\u041D\u043E\u0432\u044B\u0435 \u0432\u0438\u0434\u0435\u043E \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u044E\u0442\u0441\u044F");
      if (!image || await one2(env, "SELECT id FROM comments WHERE media_id=?", mid) || await one2(env, "SELECT id FROM posts WHERE media_id=? AND id<>?", mid, pid) || await one2(env, "SELECT post FROM post_media WHERE media=? AND post<>?", mid, pid) || await one2(env, "SELECT id FROM members WHERE avatar_id=?", mid) || await one2(env, "SELECT id FROM custom_badges WHERE media_id=?", mid)) fail(400, "\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
    }
    const commands = existing ? [stmt2(env, "DELETE FROM post_media WHERE post=?", pid), stmt2(env, "DELETE FROM exclusions WHERE post=?", pid), stmt2(env, "UPDATE posts SET text=?,media_id=?,depth=?,global=?,updated=? WHERE id=? AND author=?", text, media[0] || null, d.depth, d.global ? 1 : 0, now5(), pid, m.id)] : [stmt2(env, "INSERT INTO posts(id,author,text,media_id,depth,global,created) VALUES (?,?,?,?,?,?,?)", pid, m.id, text, media[0] || null, d.depth, d.global ? 1 : 0, now5())];
    commands.push(stmt2(env, "UPDATE posts SET poll=? WHERE id=?", poll ? JSON.stringify(poll) : null, pid));
    const cp = d.commentPolicy ?? (existing ? commentPolicy(existing) : { depth: 4, excluded: [] });
    if (!cp || ![0, 1, 2, 3, 4].includes(cp.depth) || !Array.isArray(cp.excluded) || cp.excluded.length > 200 || cp.excluded.some((id2) => typeof id2 !== "string")) fail(400, "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0435\u0432");
    commands.push(stmt2(env, "UPDATE posts SET comment_depth=?,comment_excluded=? WHERE id=?", cp.depth, JSON.stringify([...new Set(cp.excluded)].filter((id2) => id2 !== m.id)), pid));
    for (let i = 0; i < media.length; i++) commands.push(stmt2(env, "INSERT INTO post_media(post,media,position) VALUES (?,?,?)", pid, media[i], i));
    for (const x of [...new Set(d.excluded)].filter((x2) => x2 !== m.id)) commands.push(stmt2(env, "INSERT INTO exclusions(post,member) SELECT ?,id FROM members WHERE id=?", pid, x));
    commands.push(...await postTagCommands(env, c, m.id, pid, media, d.depth, d.excluded, !!d.global, d.tags));
    await env.DB.batch(commands);
    return json({ id: pid }, existing ? 200 : 201);
  }
  if (pm && method === "GET") {
    const p = await readPost2(env, m.id, pm[1]), u = await one2(env, `SELECT m.id,m.name,m.role,m.avatar_id,${onlineSQL("m")} AS online FROM members m WHERE m.id=?`, p.author), photos = await attachments([p.id]), exclusions = p.author === m.id ? await rows2(env, "SELECT e.member,u.name FROM exclusions e JOIN members u ON u.id=e.member WHERE post=?", p.id) : [];
    return json({ post: { ...p, commentPolicy: p.author === m.id ? commentPolicy(p) : null, canComment: await commentPermission(env, c, m.id, p), tags: (await tagsFor(env, [p.id])).get(p.id) || [], hiddenFrom: exclusions.map((e) => ({ id: e.member, name: e.name })), poll: (await pollsFor(env, [p.id], m.id)).get(p.id) || null, author: u.id, name: u.name, online: !!u.online, badges: (await badgesFor(env, [u.id])).get(u.id) || [], admin: isAdmin(u), staffRole: ["owner", "admin", "moderator", "support"].includes(u.role) ? u.role : null, telegramVerified: false, avatar: u.avatar_id ? "/media/" + u.avatar_id + "?thumb=1" : null, degree: u.id === m.id ? 0 : null, audience: p.depth, media: photos.get(p.id) || [], excluded: exclusions.map((x) => x.member), likes: (await one2(env, "SELECT count(*) AS n FROM likes WHERE post=?", p.id)).n, liked: !!await one2(env, "SELECT member FROM likes WHERE post=? AND member=?", p.id, m.id), commentCount: (await one2(env, "SELECT count(*) AS n FROM comments WHERE post=?", p.id)).n } });
  }
  if (pm && method === "DELETE") {
    const p = await readPost2(env, m.id, pm[1]);
    if (p.author !== m.id) fail(403, "\u041C\u043E\u0436\u043D\u043E \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0432\u043E\u0439 \u043F\u043E\u0441\u0442");
    const images = [...(await attachments([p.id])).get(p.id) || [], ...await rows2(env, "SELECT m.* FROM comments c JOIN media m ON m.id=c.media_id WHERE c.post=?", p.id)];
    await env.DB.batch([stmt2(env, "DELETE FROM comment_likes WHERE comment IN (SELECT id FROM comments WHERE post=?)", p.id), stmt2(env, "DELETE FROM notifications WHERE post=?", p.id), stmt2(env, "DELETE FROM comments WHERE post=?", p.id), stmt2(env, "DELETE FROM likes WHERE post=?", p.id), stmt2(env, "DELETE FROM exclusions WHERE post=?", p.id), stmt2(env, "DELETE FROM post_media WHERE post=?", p.id), stmt2(env, "DELETE FROM posts WHERE id=?", p.id)]);
    for (const image of images) {
      await env.BUCKET.delete(image.id);
      await env.BUCKET.delete(image.id + "/thumb");
      await stmt2(env, "DELETE FROM media WHERE id=?", image.id).run();
    }
    return json({ ok: true });
  }
  if (path === "/reef-api/media" && method === "POST") {
    await rate2(env, "upload:" + m.id, 100, 86400);
    const max = 9 * 1024 * 1024;
    const contentType = request.headers.get("content-type") || "";
    let bytes, thumb = null, width = null, height = null, kind = null, duration = null;
    if (contentType.includes("multipart/form-data")) {
      const boundedBytes = await c.bounded(request, max);
      const form = await new Response(boundedBytes, { headers: { "content-type": contentType } }).formData();
      kind = form.get("kind");
      duration = Number(form.get("duration"));
      const file = form.get("file");
      if (!file || typeof file === "string") fail(400, "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0444\u0430\u0439\u043B");
      bytes = new Uint8Array(await file.arrayBuffer());
      const preview = form.get("thumbnail");
      if (preview && typeof preview !== "string") {
        if (preview.size > 256 * 1024) fail(400, "\u041F\u0440\u0435\u0432\u044C\u044E \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435");
        thumb = new Uint8Array(await preview.arrayBuffer());
        if (!imageType(thumb)) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u043F\u0440\u0435\u0432\u044C\u044E");
      }
      width = Math.min(1e4, Math.max(0, Number(form.get("width")) || 0)) || null;
      height = Math.min(1e4, Math.max(0, Number(form.get("height")) || 0)) || null;
    } else bytes = await c.bounded(request, max);
    const type = imageType(bytes) || videoType(bytes);
    if (type?.startsWith("video/") && (kind !== "square" || !Number.isFinite(duration) || duration <= 0 || duration > 60 || width !== height || !width || width > 720)) fail(400, "\u0412\u0438\u0434\u0435\u043E\u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A \u2014 \u0434\u043E \u043C\u0438\u043D\u0443\u0442\u044B, \u0434\u043E 720\xD7720");
    if (!type || bytes.length > 8 * 1024 * 1024) fail(400, "\u0424\u043E\u0442\u043E \u0438 \u0432\u0438\u0434\u0435\u043E\u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A\u0438 \u2014 \u0434\u043E 8 \u041C\u0411");
    if (type.startsWith("image/") && bytes.length > 8 * 1024 * 1024) fail(400, "\u0424\u043E\u0442\u043E \u2014 \u0434\u043E 8 \u041C\u0411");
    const mid = uuid();
    await env.BUCKET.put(mid, bytes, { httpMetadata: { contentType: type } });
    if (thumb) await env.BUCKET.put(mid + "/thumb", thumb, { httpMetadata: { contentType: imageType(thumb) } });
    try {
      await stmt2(env, "INSERT INTO media(id,owner,type,size,thumbnail,width,height,kind,duration,created) VALUES (?,?,?,?,?,?,?,?,?,?)", mid, m.id, type, bytes.length, thumb ? 1 : 0, width, height, type.startsWith("video/") ? "square" : null, type.startsWith("video/") ? Math.ceil(duration) : null, now5()).run();
    } catch (e) {
      await env.BUCKET.delete(mid);
      await env.BUCKET.delete(mid + "/thumb");
      throw e;
    }
    return json(mediaShape({ id: mid, type, thumbnail: thumb ? 1 : 0, width, height, kind: type.startsWith("video/") ? "square" : null, duration: type.startsWith("video/") ? Math.ceil(duration) : null }), 201);
  }
  if (path.startsWith("/media/") && (method === "GET" || method === "HEAD")) {
    const mid = path.slice(7), image = await one2(env, "SELECT * FROM media WHERE id=?", mid);
    if (!image) fail(404, "\u0424\u0430\u0439\u043B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    const avatar = await one2(env, "SELECT id FROM members WHERE avatar_id=?", mid);
    const badgeImage = await one2(env, "SELECT id FROM custom_badges WHERE media_id=? LIMIT 1", mid);
    if (!avatar && !badgeImage) {
      const p = await one2(env, "SELECT id FROM posts WHERE media_id=? UNION SELECT post AS id FROM post_media WHERE media=? UNION SELECT post AS id FROM comments WHERE media_id=? LIMIT 1", mid, mid, mid);
      if (p) await readPost2(env, m.id, p.id);
      else if (image.owner !== m.id) fail(404, "\u0424\u0430\u0439\u043B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    }
    const thumbnail = url.searchParams.has("thumb") && image.thumbnail, key = mid + (thumbnail ? "/thumb" : ""), etag = '"' + mid + (thumbnail ? "-thumb" : "") + '"';
    if (request.headers.get("if-none-match") === etag && !request.headers.has("range")) return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
    let requestedRange = null;
    if (request.headers.has("range") && !thumbnail) {
      const match = request.headers.get("range").match(/^bytes=(\d*)-(\d*)$/);
      if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + image.size } });
      const offset = match[1] ? Number(match[1]) : Math.max(0, image.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(image.size - 1, Number(match[2])) : image.size - 1;
      if (offset >= image.size || end < offset) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + image.size } });
      requestedRange = { offset, length: end - offset + 1 };
    }
    const blob = await env.BUCKET.get(key, requestedRange ? { range: requestedRange } : void 0);
    if (!blob) fail(404, "\u0424\u0430\u0439\u043B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    const headers = { "content-type": thumbnail ? blob.httpMetadata?.contentType || "image/jpeg" : image.type, "cache-control": "private, no-cache", "x-content-type-options": "nosniff", "accept-ranges": "bytes", etag };
    let status = 200;
    if (requestedRange) {
      headers["content-range"] = `bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${image.size}`;
      headers["content-length"] = String(requestedRange.length);
      status = 206;
    } else if (blob.size != null) headers["content-length"] = String(blob.size);
    return new Response(method === "HEAD" ? null : blob.body, { status, headers });
  }
  return null;
}

// worker/assets.mjs
var assets = { "/index.html": { "body": `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff"><meta name="description" content="Reef \u2014 \u0441\u0432\u043E\u0438 \u043B\u044E\u0434\u0438 \u0438 \u0438\u0445 \u043C\u043E\u043C\u0435\u043D\u0442\u044B."><link rel="manifest" href="/manifest.webmanifest"><title>Reef</title><link rel="stylesheet" href="/style.css?v=20261117a"><script>try{document.documentElement.dataset.theme=localStorage.getItem('reef-theme')||'light'}catch{}</script></head><body><main id="posts" aria-label="\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438"></main><div class="floating-actions"><button class="invite-button" onclick="showInvite()" aria-label="\u041F\u0440\u0438\u0433\u043B\u0430\u0441\u0438\u0442\u044C \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0435 \u0438\u043B\u0438 QR-\u043A\u043E\u0434\u0443"><i data-icon="userPlus"></i></button><button class="create-button" onclick="centralAction()" aria-label="\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E"><i data-icon="plus"></i></button><button class="profile-button" onclick="openProfile(me.id)" aria-label="\u041C\u043E\u0439 \u043F\u0440\u043E\u0444\u0438\u043B\u044C"><i data-icon="user"></i></button><button class="inbox-button" onclick="openInbox()" aria-label="\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F"><i data-icon="comment"></i></button><button id="filter-button" class="filter-button" onclick="showFilters()" aria-label="\u0424\u0438\u043B\u044C\u0442\u0440\u044B \u043B\u0435\u043D\u0442\u044B"><i data-icon="sliders"></i></button></div><div id="modalroot"></div><div id="lightboxroot"></div><input type="file" id="file" accept="image/*" multiple hidden><input type="file" id="camera-file" accept="image/*" capture="environment" hidden><input type="file" id="avatar-file" accept="image/*" hidden><script src="/qr.js"></script><script src="/app.js?v=20261117a" defer></script></body></html>`, "type": "text/html;charset=utf-8" }, "/app.js": { "body": 'const icons={home:\'<path d="m3 10 9-7 9 7v10H4V10"/><path d="M9 20v-7h6v7"/>\',feed:\'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 7h8M8 11h8M8 15h3M8 18h7"/>\',users:\'<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5"/>\',circle:\'<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="9"/><circle cx="12" cy="3" r="2" fill="currentColor" stroke="none"/><circle cx="20" cy="17" r="2" fill="currentColor" stroke="none"/><circle cx="4" cy="17" r="2" fill="currentColor" stroke="none"/>\',bell:\'<path d="M5 17h14l-2-4V9a5 5 0 0 0-10 0v4zM10 21h4"/>\',settings:\'<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>\',user:\'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>\',userPlus:\'<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M19 8v6M16 11h6"/>\',plus:\'<path d="M12 5v14M5 12h14"/>\',search:\'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>\',chevron:\'<path d="m9 5 7 7-7 7"/>\',arrowRight:\'<path d="M4 12h16m-6-6 6 6-6 6"/>\',image:\'<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 7"/>\',lock:\'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>\',send:\'<path d="m3 3 19 9-19 9 4-9zM7 12h15"/>\',sliders:\'<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="white"/><circle cx="16" cy="17" r="2" fill="white"/>\',heart:\'<path d="M20 5c-3-3-7 0-8 2-1-2-5-5-8-2-4 4 0 9 8 15 8-6 12-11 8-15Z"/>\',comment:\'<path d="M21 11a9 9 0 0 1-9 9H4l1-5a9 9 0 1 1 16-4Z"/>\',eye:\'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>\',mail:\'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 6 9 7 9-7"/>\',info:\'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>\',check:\'<path d="m5 12 4 4L20 5"/>\'};icons.comment=\'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>\',icons.heart=\'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/>\',icons.settings=\'<path d="M9.2 4.2 9.8 2h4.4l.6 2.2 1.8 1 2.2-.6 2.2 3.8-1.6 1.6v2l1.6 1.6-2.2 3.8-2.2-.6-1.8 1-.6 2.2H9.8l-.6-2.2-1.8-1-2.2.6L3 13.6 4.6 12v-2L3 8.4l2.2-3.8 2.2.6z" transform="translate(0 1)"/><circle cx="12" cy="12" r="3"/>\';const svg=e=>`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[e]||icons.circle}</svg>`;function hydrate(){document.querySelectorAll("[data-icon]").forEach(e=>{e.outerHTML=svg(e.dataset.icon)})}const esc=e=>String(e).replace(/[&<>"\']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"})[t]);icons.moon=\'<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11Z"/>\',icons.sun=\'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>\',icons.camera=\'<path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="4"/>\',icons.back=\'<path d="m14 5-7 7 7 7"/>\',icons.edit=\'<path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/>\',icons.video=\'<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-4v12l-5-4"/>\',icons.flip=\'<path d="M4 8a9 9 0 0 1 15-3l2 3M21 3v5h-5M20 16A9 9 0 0 1 5 19l-2-3M3 21v-5h5"/>\';let authMode="password",emailChallenge=null,state={posts:[],depth:3,muted:[]},me=null,view="feed",profile=null,profilePosts=[],profileNext=null,feedNext=null,feedReady=!1,loading=!1,loadGeneration=0,lastFocus=null,composerOpen=!1,pendingAuth=!1,inviteToken="",inviteLink="",inviteCode="",inviteExpiry=0,invitePending=!1,audiencePeople=[],cameraStream=null,cameraFacing="environment",uploading=!1,editProfileData=null,activeChat=null,chatNext=null,chatMessages=[],lastChatKey="";const main=document.getElementById("posts"),openComments=new Set,commentCache=new Map,busy=new Set;let draft=freshDraft();function freshDraft(){return{id:null,text:"",attachments:[],privacy:3,excluded:[],global:!1,poll:null,tags:[],commentPolicy:{depth:4,excluded:[]}}}const badge=()=>staffBadge("admin"),initials=e=>e.trim().split(/\\s+/).slice(0,2).map(t=>t[0]).join("").toUpperCase();function avatar(e,t=""){return`<div class="avatar me ${t}">${e.avatar?`<img src="${esc(e.avatar)}" alt="" loading="lazy" decoding="async">`:esc(initials(e.name||"Reef"))}${e.online?\'<span class="avatar-online" aria-label="\u041E\u043D\u043B\u0430\u0439\u043D"></span>\':""}</div>`}async function api(e,t={}){const n=await fetch(e,{credentials:"same-origin",...t,headers:{...typeof t.body=="string"?{"content-type":"application/json"}:{},...t.headers}});let a;try{a=await n.json()}catch{throw Error("\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.")}if(!n.ok)throw n.status===401&&me&&(me=null,closeModal(),showAuth()),Error(a.error||"\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435");return a}function dateLabel(e){const t=Math.max(0,Math.floor(Date.now()/1e3)-e);return t<60?"\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E":t<3600?Math.floor(t/60)+" \u043C\u0438\u043D. \u043D\u0430\u0437\u0430\u0434":t<86400?Math.floor(t/3600)+" \u0447. \u043D\u0430\u0437\u0430\u0434":new Date(e*1e3).toLocaleDateString("ru-RU",{day:"numeric",month:"long"})}function showActions(e){const t=document.querySelector(".floating-actions");t.hidden!==!e&&(t.hidden=!e),syncNavigationLayer()}function actions(){const e=main.dataset.screen;e==="feed"&&view!=="feed"&&rememberFeedPosition(),main.dataset.screen=view,applyFeedMode(),showActions(!!me);const t=document.querySelector(".create-button");t&&(updateCentralIcon(t,view==="feed"?"plus":"home",e,view),t.setAttribute("aria-label",view==="feed"?"\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E":"\u0412 \u043B\u0435\u043D\u0442\u0443"))}async function boot(){try{const e=new URLSearchParams(location.hash.slice(1));inviteToken=e.get("invite")||e.get("setup")||sessionStorage.getItem("reef-invite")||"",inviteToken&&(sessionStorage.setItem("reef-invite",inviteToken),history.replaceState(null,"",location.pathname));const t=await api("/reef-api/me");if(authMode=t.authMode||"password",me=t.user,me)inviteToken="",sessionStorage.removeItem("reef-invite"),state.depth=me.depth,state.muted=me.muted,view="feed",actions(),await restoreRoute(),afterLogin();else if(showActions(!1),inviteToken)try{showAuth(!0,await api("/reef-api/invite/info",{method:"POST",body:JSON.stringify({token:inviteToken})}))}catch(n){inviteToken="",sessionStorage.removeItem("reef-invite"),showAuth(!1,null,n.message)}else showAuth()}catch(e){main.innerHTML=`<div class="empty">${esc(e.message)}<br><button class="primary" style="margin:20px auto" onclick="boot()">\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C</button></div>`}}function showAuth(e=!1,t=null,n=""){if(authMode==="email-code")return showEmailAuth(e,t,n);view="auth",showActions(!1),main.innerHTML=`<section class="auth-card"><div class="reef-wordmark">Reef</div><h1>${e?t?.setup?"\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0430\u043A\u043A\u0430\u0443\u043D\u0442":"\u0412\u0430\u0441 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0430\u044E\u0442 \u0432 Reef":"\u0412\u043E\u0439\u0442\u0438"}</h1>${e&&!t?.setup?`<p>${esc(t?.name||"\u0412\u0430\u0448 \u0434\u0440\u0443\u0433")} \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0430\u0435\u0442 \u0432\u0430\u0441 \u0432 \u0441\u0432\u043E\u0439 \u043A\u0440\u0443\u0433.</p>`:""}<form onsubmit="submitAuth(event,${e})">${e?\'<label for="auth-name">\u0418\u043C\u044F</label><input id="auth-name" name="name" autocomplete="name" minlength="2" maxlength="60" required placeholder="\u041A\u0430\u043A \u0432\u0430\u0441 \u0437\u043E\u0432\u0443\u0442">\':""}<label for="auth-email">\u041F\u043E\u0447\u0442\u0430</label><input id="auth-email" name="email" type="email" autocomplete="username" maxlength="254" required placeholder="user@example.com"><label for="auth-password">\u041F\u0430\u0440\u043E\u043B\u044C</label><input id="auth-password" name="password" type="password" autocomplete="${e?"new-password":"current-password"}" minlength="10" maxlength="128" required placeholder="\u041D\u0435 \u043C\u0435\u043D\u0435\u0435 10 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432"><div id="auth-error" role="alert">${esc(n)}</div><button id="auth-submit" class="primary" type="submit">${e?"\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0430\u043A\u043A\u0430\u0443\u043D\u0442":"\u0412\u043E\u0439\u0442\u0438"}</button></form>${e?\'<button class="auth-switch" onclick="showAuth()">\u0423\u0436\u0435 \u0435\u0441\u0442\u044C \u0430\u043A\u043A\u0430\u0443\u043D\u0442? \u0412\u043E\u0439\u0442\u0438</button>\':\'<button class="auth-switch" onclick="showFriendCodeForm()">\u0423 \u043C\u0435\u043D\u044F \u0435\u0441\u0442\u044C \u043A\u043E\u0434 \u043E\u0442 \u0434\u0440\u0443\u0433\u0430</button>\'}</section>`}async function submitAuth(e,t){if(e.preventDefault(),pendingAuth)return;pendingAuth=!0;const n=document.getElementById("auth-submit");n.disabled=!0,document.getElementById("auth-error").textContent="";try{const a=new FormData(e.target);me=(await api(t?"/reef-api/auth/register":"/reef-api/auth/login",{method:"POST",body:JSON.stringify({email:a.get("email"),password:a.get("password"),name:a.get("name"),token:inviteToken})})).user,state.depth=me.depth,state.muted=me.muted,inviteToken="",sessionStorage.removeItem("reef-invite"),view="feed",actions(),await restoreRoute(),afterLogin()}catch(a){const o=document.getElementById("auth-error");o&&(o.textContent=a.message),n.disabled=!1}finally{pendingAuth=!1}}const mediaObserver=new IntersectionObserver(e=>{for(const t of e){if(!t.isIntersecting)continue;const n=t.target;n.dataset.src&&(n.src=n.dataset.src,delete n.dataset.src),n.dataset.poster&&(n.poster=n.dataset.poster,delete n.dataset.poster),mediaObserver.unobserve(n)}},{root:main,rootMargin:"350px 0px"}),pageObserver=new IntersectionObserver(e=>{e.some(t=>t.isIntersecting)&&(view==="feed"&&feedNext?loadFeed():view==="profile"&&profileNext&&loadProfilePosts())},{root:main,rootMargin:"450px 0px"}),videoObserver=new IntersectionObserver(e=>{for(const t of e)t.isIntersecting||t.target.pause()},{threshold:.05}),videoReleaseObserver=new IntersectionObserver(e=>{for(const t of e){const n=t.target;!t.isIntersecting&&n.getAttribute("src")?(n.pause(),n.dataset.src=n.getAttribute("src"),n.removeAttribute("src"),n.load()):t.isIntersecting&&n.dataset.src&&(n.src=n.dataset.src,delete n.dataset.src)}},{rootMargin:"800px 0px"});function observe(e=document){observePhotoFrames(e),e.querySelectorAll("video").forEach(n=>{videoObserver.observe(n),videoReleaseObserver.observe(n)}),e.querySelectorAll("[data-src],[data-poster]").forEach(n=>{main.contains(n)?mediaObserver.observe(n):(n.dataset.src&&(n.src=n.dataset.src,delete n.dataset.src),n.dataset.poster&&(n.poster=n.dataset.poster,delete n.dataset.poster))});const t=document.getElementById("page-sentinel");pageObserver.disconnect(),t&&pageObserver.observe(t),hydrate()}function sentinel(e){return`<div class="page-sentinel" id="page-sentinel" ${e?"":"hidden"}>${e?`<button class="reef-load-trigger" onclick="loadMore()" aria-label="\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0435\u0449\u0451 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438">${reefLoader()}</button>`:""}</div>`}function loadMore(){view==="profile"?loadProfilePosts(!profilePosts.length):loadFeed(!feedReady)}function setLoading(e){const t=document.getElementById("page-sentinel");t&&(t.hidden=!1,t.setAttribute("aria-busy",String(e)),t.innerHTML=e?reefLoader():\'<button class="reef-load-retry" onclick="loadMore()">\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0443</button>\')}async function loadFeed(e=!1){if(loading&&!e||!e&&!feedNext&&feedReady)return;const t=e?++loadGeneration:loadGeneration;loading=!0,e&&(feedPosition=null,feedNext=null,feedReady=!1,state.posts=[],view==="feed"&&(main.innerHTML=\'<div id="feed-list"></div>\'+sentinel(null))),setLoading(!0);try{const n=await api("/reef-api/posts?limit=8"+(!e&&feedNext?"&cursor="+encodeURIComponent(feedNext):""));if(t!==loadGeneration||view!=="feed")return;const a=new Set(state.posts.map(s=>s.id)),o=n.posts.filter(s=>!a.has(s.id));state.posts.push(...o),feedNext=n.next,feedReady=!0;const i=document.getElementById("feed-list");i&&(e&&(i.innerHTML=""),i.insertAdjacentHTML("beforeend",o.map(postHTML).join("")),state.posts.length||(i.innerHTML=\'<div class="empty">\u0417\u0434\u0435\u0441\u044C \u0431\u0443\u0434\u0443\u0442 \u0432\u0430\u0448\u0438 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438.<br>\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB+\xBB, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u0434\u0435\u043B\u0438\u0442\u044C\u0441\u044F \u043F\u0435\u0440\u0432\u044B\u043C \u043C\u043E\u043C\u0435\u043D\u0442\u043E\u043C.</div>\')),document.getElementById("page-sentinel")?.replaceWith(htmlNode(sentinel(feedNext))),updateFilter(),observe()}catch(n){toast(n.message),setLoading(!1)}finally{t===loadGeneration&&(loading=!1)}}function htmlNode(e){const t=document.createElement("template");return t.innerHTML=e,t.content.firstElementChild}function updateFilter(){document.getElementById("filter-button").className="filter-button"+(state.depth<3||state.muted.length?" filtered":"")}function backToFeed(){view==="feed"&&main.querySelector("#feed-list")&&rememberFeedPosition(),++loadGeneration,loading=!1,view="feed",rememberRoute("feed"),profile=null,activeChat=null,actions(),main.innerHTML=\'<div id="feed-list">\'+state.posts.map(postHTML).join("")+"</div>"+sentinel(feedNext),restoreFeedPosition(),observe(),queueScreenAnimation(),feedReady||loadFeed(!0)}function mediaHTML(e){return e.media?.length?`<div class="gallery-wrap"><div class="gallery" onscroll="galleryScrolled(this)" data-count="${e.media.length}">${e.media.map((t,n)=>`<div class="media-slide">${t.type.startsWith("video/")?`<video data-src="${esc(t.url)}" poster="${esc(t.thumbnail||"")}" class="${t.kind==="square"?"square-video":""}" preload="none" controls playsinline onplay="pauseOtherVideos(this)" aria-label="\u0412\u0438\u0434\u0435\u043E ${n+1}"></video>`:`<div class="photo-static" data-full="${esc(t.url)}" aria-label="\u0424\u043E\u0442\u043E. \u041F\u0440\u0438\u0431\u043B\u0438\u0436\u0430\u0439\u0442\u0435 \u0434\u0432\u0443\u043C\u044F \u043F\u0430\u043B\u044C\u0446\u0430\u043C\u0438"><img data-src="${esc(t.thumbnail||t.url)}" alt="\u0424\u043E\u0442\u043E \u043A \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438" loading="lazy" decoding="async" ${t.width&&t.height?`width="${t.width}" height="${t.height}"`:""}><div class="photo-tags" data-photo-tags="${t.id}">${photoTagDots(e,t.id)}</div></div>`}</div>`).join("")}</div>${e.media.length>1?`<span class="gallery-counter">1 / ${e.media.length}</span><div class="gallery-dots">${e.media.map((t,n)=>`<button class="${n===0?"active":""}" onclick="galleryGo(this,${n})" aria-label="\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u0435 ${n+1}"></button>`).join("")}</div>`:""}</div>`:""}function galleryGo(e,t){const n=e.closest(".gallery-wrap").querySelector(".gallery");n.scrollTo({left:t*n.clientWidth,behavior:"smooth"})}function galleryScrolled(e){e._frame||(e._frame=requestAnimationFrame(()=>{e._frame=null;const t=Math.round(e.scrollLeft/e.clientWidth),n=e.parentElement,a=n.querySelector(".gallery-counter");a&&(a.textContent=t+1+" / "+e.dataset.count),n.querySelectorAll(".gallery-dots button").forEach((o,i)=>o.classList.toggle("active",t===i)),e.querySelectorAll("video").forEach(o=>{o.closest(".media-slide").isSameNode(e.children[t])||o.pause()})}))}function pauseOtherVideos(e){document.querySelectorAll("video").forEach(t=>{t!==e&&t.pause()})}function postHTML(e){const t=e.author===me?.id;return`<article class="post ${e.media?.length?"has-media":"text-only"} ${e.poll?"has-poll":""}" data-post-id="${e.id}" ondblclick="doubleLike(event,\'${e.id}\')"><div class="posthead"><button class="author-button" onclick="openProfile(\'${e.author}\')">${avatar(e)}<div><div class="author"><span class="author-name">${esc(e.name)}</span>${customBadgesHTML(e.badges)}${e.telegramVerified?verifiedBadge():""}${e.staffRole||e.admin?staffBadge(e.staffRole||"admin"):""}${t?\'<span class="degree own-degree">\u0412\u044B</span>\':e.degree?`<span class="degree d${e.degree}">${e.degree===1?"\u0414\u0440\u0443\u0433":e.degree+"-\u0439 \u043A\u0440\u0443\u0433"}</span>`:""}</div><div class="meta">${dateLabel(e.created)}${e.updated?" \xB7 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u043E":""}${!t&&e.via?" \xB7 "+esc(e.via):""}</div></div></button><button class="more" aria-label="\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u0441 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0435\u0439" onclick="postMenu(\'${e.id}\')">\xB7\xB7\xB7</button></div>${e.text?`<div class="posttext">${postTextHTML(e)}</div>`:\'<div style="height:14px"></div>\'}${mediaHTML(e)}${pollHTML(e)}<div class="postfoot"><button data-like="${e.id}" class="${e.liked?"liked":""}" onclick="like(\'${e.id}\')" aria-label="\u041D\u0440\u0430\u0432\u0438\u0442\u0441\u044F" aria-pressed="${e.liked}">${svg("heart")}<span class="sr-only">${e.likes}</span></button><button class="post-like-count" data-like-count="${e.id}" onclick="showPostLikes(\'${e.id}\')" aria-label="\u041A\u0442\u043E \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u043B \u043B\u0430\u0439\u043A">${e.likes||""}</button><button data-comments="${e.id}" onclick="toggleComments(\'${e.id}\')" aria-label="\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438">${svg("comment")}<span>${e.commentCount||""}</span></button>${t?`<span class="visibility">${svg("eye")}${e.global?"\u0412\u0441\u0435\u043C \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0430\u043C":"\u0414\u043E "+e.audience+"-\u0433\u043E \u043A\u0440\u0443\u0433\u0430"}</span>`:""}</div>${hiddenFromHTML(e)}<div class="comments-slot">${openComments.has(e.id)&&!isScreenFeed()?commentsHTML(e.id):""}</div></article>`}let detailPost=null;function findPost(e){return state.posts.find(t=>t.id===e)||profilePosts.find(t=>t.id===e)||(detailPost?.id===e?detailPost:null)}async function like(e,t=!1){if(!busy.has(e)){busy.add(e);try{const n=findPost(e);if(!n)return;const a=t?!0:!n.liked;if(n.liked===a)return;pulseLike(`[data-like="${e}"]`),await api("/reef-api/posts/"+e+"/likes",{method:"PUT",body:JSON.stringify({liked:a})}),n.likes+=a?1:-1,n.liked=a,n._liveVersion=(n._liveVersion||0)+1,document.querySelectorAll(`[data-like="${e}"]`).forEach(o=>{o.classList.toggle("liked",n.liked),o.setAttribute("aria-pressed",n.liked),o.querySelector("span").textContent=n.likes,document.querySelectorAll(`[data-like-count="${n.id}"]`).forEach(i=>i.textContent=n.likes||"")})}catch(n){toast(n.message)}finally{busy.delete(e)}}}function commentsHTML(e){const t=commentReplies.get(e);return`<div class="comments"><div class="comments-items">${(commentCache.get(e)||[]).map(n=>`<div class="comment" data-comment-id="${n.id}"><button class="comment-avatar" onclick="openProfile(\'${n.member}\')" aria-label="\u041F\u0440\u043E\u0444\u0438\u043B\u044C ${esc(n.name)}">${avatar(n)}</button><div class="comment-content"><div class="comment-copy"><button class="comment-author" onclick="openProfile(\'${n.member}\')"><strong>${esc(n.name)}</strong></button>${customBadgesHTML(n.badges)}${n.telegramVerified?verifiedBadge():""}${n.staffRole?staffBadge(n.staffRole):""}${n.reply_to?`<button type="button" class="comment-reply-quote" onclick="highlightComment(\'${e}\',\'${n.reply_to}\')"><strong>${esc(n.reply_name||"\u041E\u0442\u0432\u0435\u0442")}</strong><small>${esc((n.reply_text||"\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u0435").slice(0,100))}</small></button>`:""}<div class="comment-text">${linkifyText(n.text)}</div>${commentMediaHTML(n)}<button class="comment-reply-button" onclick="replyToComment(\'${e}\',\'${n.id}\')">\u041E\u0442\u0432\u0435\u0442\u0438\u0442\u044C</button></div><button class="comment-like ${n.liked?"liked":""}" data-comment-like="${n.id}" onclick="likeComment(\'${e}\',\'${n.id}\')" aria-label="\u041D\u0440\u0430\u0432\u0438\u0442\u0441\u044F \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439" aria-pressed="${!!n.liked}">${svg("heart")}<span>${n.likes||""}</span></button></div></div>`).join("")}</div>${commentComposerHTML(e)}<form class="comment-form" onsubmit="addComment(event,\'${e}\')"><div class="comment-input-wrap">${t?`<div class="replying-to">\u041E\u0442\u0432\u0435\u0442 ${esc(t.name)}<button type="button" onclick="clearCommentReply(\'${e}\')" aria-label="\u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442">\xD7</button></div>`:""}<input name="comment" maxlength="1000" ${findPost(e)?.canComment===!1?"disabled":""} placeholder="${t?"\u041E\u0442\u0432\u0435\u0442\u0438\u0442\u044C\u2026":"\u041D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439\u2026"}" aria-label="\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439"></div><button type="button" onclick="pickCommentMedia(\'${e}\')" aria-label="\u041F\u0440\u0438\u043A\u0440\u0435\u043F\u0438\u0442\u044C \u0444\u043E\u0442\u043E">${svg("image")}</button><button type="button" onclick="openSquareRecorder(\'${e}\')" aria-label="\u0417\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E\u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A">${svg("video")}</button><button ${findPost(e)?.canComment===!1?"disabled":""} aria-label="\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C">${svg("send")}</button></form></div>`}function updateComments(e){document.querySelectorAll(`[data-post-id="${e}"] .comments-slot`).forEach(t=>{t.innerHTML=isScreenFeed()&&t.closest("#feed-list")?"":openComments.has(e)?commentsHTML(e):""})}async function toggleComments(e){if(!busy.has("comments-open:"+e)){if(openComments.has(e)){openComments.delete(e),updateComments(e),setCommentExpanded(e,!1);return}busy.add("comments-open:"+e),document.querySelectorAll(`[data-comments="${e}"]`).forEach(t=>t.classList.add("loading-comments"));try{const t=await api("/reef-api/posts/"+e+"/comments");commentCache.set(e,t.comments),findPost(e)&&(findPost(e).canComment=t.canComment!==!1),openComments.add(e),isScreenFeed()?modal("\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438",`<div class="comments-sheet" data-post-id="${e}"><div class="comments-slot">${commentsHTML(e)}</div></div>`,"comments-modal"):(updateComments(e),document.querySelector(`[data-post-id="${e}"] .comments`)?.scrollIntoView?.({block:"nearest",behavior:"smooth"})),setCommentExpanded(e,!0)}catch(t){toast(t.message)}finally{busy.delete("comments-open:"+e),document.querySelectorAll(`[data-comments="${e}"]`).forEach(t=>t.classList.remove("loading-comments"))}}}function setCommentExpanded(e,t){document.querySelectorAll(`[data-comments="${e}"]`).forEach(n=>{n.classList.toggle("comments-expanded",t),n.setAttribute("aria-expanded",t)})}async function addComment(e,t){e.preventDefault();const n=e.target.comment.value.trim(),a=commentAttachments.get(t);if(!(!n&&!a||commentUploads.has(t)||busy.has("comment:"+t))){busy.add("comment:"+t);try{await api("/reef-api/posts/"+t+"/comments",{method:"POST",body:JSON.stringify({text:n,mediaId:a?.id||null,replyTo:commentReplies.get(t)?.id||null})}),commentReplies.delete(t),commentAttachments.delete(t),commentCache.set(t,(await api("/reef-api/posts/"+t+"/comments")).comments);const o=findPost(t);o._liveVersion=(o._liveVersion||0)+1,o.commentCount++,document.querySelectorAll(`[data-comments="${t}"] span`).forEach(i=>i.textContent=o.commentCount),updateComments(t)}catch(o){toast(o.message)}finally{busy.delete("comment:"+t)}}}function stopCamera(){cameraStream&&(cameraStream.getTracks().forEach(e=>e.stop()),cameraStream=null)}function modal(e,t,n=""){/\u041F\u0440\u0438\u0433\u043B\u0430\u0441|\u041F\u0440\u0438\u0433\u043B\u0430\u0448/.test(e)&&(n+=" invite-modal");const a=n.includes("push-settings-modal")?"openAccountMenu()":view==="admin"&&e!=="\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438"?"closeModal()":"";stopCamera(),lastFocus=document.activeElement,document.getElementById("modalroot").innerHTML=`<div class="modalback" onclick="if(event.target===this)closeModal()"><section class="modal ${n}" role="dialog" aria-modal="true" aria-label="${e}"><button class="sheet-handle" aria-label="\u041F\u043E\u0442\u044F\u043D\u0438\u0442\u0435 \u0432\u043D\u0438\u0437, \u0447\u0442\u043E\u0431\u044B \u0437\u0430\u043A\u0440\u044B\u0442\u044C" onclick="closeModal()"><span></span></button><button class="close" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C" onclick="closeModal()">\xD7</button><div class="modal-heading">${a?`<button class="modal-back" onclick="${a}" aria-label="${a==="openAccountMenu()"?"\u041A \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u043C":"\u041D\u0430\u0437\u0430\u0434"}">${svg("back")}</button>`:""}<h2>${e}</h2></div>${t}</section></div>`,document.body.style.overflow="hidden",hydrate(),document.querySelector(".modal .close").focus(),bindSheetDrag(),syncNavigationLayer()}function closeModal(){const e=document.querySelector(".comments-sheet");e&&(openComments.delete(e.dataset.postId),setCommentExpanded(e.dataset.postId,!1)),composerOpen=!1,stopCamera(),document.querySelectorAll("#modalroot video").forEach(t=>t.pause()),document.getElementById("modalroot").innerHTML="",document.body.style.overflow="",syncNavigationLayer(),lastFocus?.focus?.()}function showComposer(){modal(draft.id?"\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043C\u043E\u043C\u0435\u043D\u0442":"\u041D\u043E\u0432\u044B\u0439 \u043C\u043E\u043C\u0435\u043D\u0442",`<div class="composer-author">${avatar({...me,online:!me.invisible})}<div><strong>${esc(me.name)}</strong><small>\u041F\u043E\u0434\u0435\u043B\u0438\u0442\u0435\u0441\u044C \u0442\u0435\u043C, \u0447\u0442\u043E \u0445\u043E\u0447\u0435\u0442\u0441\u044F \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</small></div></div><textarea id="posttext" class="compose-input" oninput="draft.text=this.value;resizeComposerText(this)" placeholder="\u0427\u0442\u043E \u0441\u0434\u0435\u043B\u0430\u043B\u043E \u0432\u0430\u0448 \u0434\u0435\u043D\u044C?" aria-label="\u0422\u0435\u043A\u0441\u0442 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438" maxlength="5000">${esc(draft.text)}</textarea><div id="poll-editor"></div><div id="attachment-preview" class="composer-thumbs"></div><div class="upload-status" id="upload-status" aria-live="polite"></div><div class="compose-tools"><button onclick="document.getElementById(\'file\').click()">${svg("image")}\u0424\u043E\u0442\u043E</button><button onclick="openCamera()">${svg("camera")}\u041A\u0430\u043C\u0435\u0440\u0430</button><button onclick="toggleDraftPoll()">${svg("sliders")}\u041E\u043F\u0440\u043E\u0441</button><button onclick="openSquareRecorder()">${svg("video")}\u041A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A</button></div><button class="composer-audience" onclick="showCommentPolicy()">${svg("comment")}<span><strong>\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438</strong><small>${commentPolicyLabel()}</small></span>${svg("chevron")}</button><button class="composer-audience" onclick="showPrivacy()">${svg("lock")}<span><strong>\u041A\u0442\u043E \u0443\u0432\u0438\u0434\u0438\u0442</strong><small id="compose-audience">\u0412\u044B\u0431\u0438\u0440\u0430\u0435\u043C \u043A\u0440\u0443\u0433\u2026</small></span>${svg("chevron")}</button>${["owner","admin"].includes(me.role)?`<label class="global-check"><input type="checkbox" onchange="draft.global=this.checked;previewAudience()" ${draft.global?"checked":""}>\u0412\u0441\u0435\u043C \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0430\u043C Reef</label>`:""}<div class="composer-footer"><button id="publish-button" class="primary" onclick="publish()" ${uploading?"disabled":""}>${draft.id?"\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F":"\u041F\u043E\u0434\u0435\u043B\u0438\u0442\u044C\u0441\u044F \u043C\u043E\u043C\u0435\u043D\u0442\u043E\u043C"} ${svg("send")}</button></div>`,"composer-modal"),composerOpen=!0,renderAttachments(),renderPollEditor(),previewAudience();const e=document.getElementById("posttext");resizeComposerText(e),e.focus()}function renderAttachments(){const e=document.getElementById("attachment-preview");e&&(e.innerHTML=draft.attachments.map((t,n)=>`<div class="composer-thumb">${t.type?.startsWith("video/")?`<video src="${esc(t.url)}" poster="${esc(t.thumbnail||"")}" muted playsinline preload="metadata"></video>`:`<img src="${esc(t.thumbnail||t.url)}" alt="\u0424\u043E\u0442\u043E ${n+1}">`}<button class="remove-attachment" onclick="removeAttachment(${n})" aria-label="\u0423\u0431\u0440\u0430\u0442\u044C \u0444\u043E\u0442\u043E">\xD7</button>${t.type?.startsWith("video/")?"":`<button class="crop-attachment" onclick="cropAttachment(${n})" aria-label="\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0444\u043E\u0442\u043E">${svg("edit")}</button><button class="tag-attachment" onclick="tagAttachment(${n})" aria-label="\u041E\u0442\u043C\u0435\u0442\u0438\u0442\u044C \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430">${svg("userPlus")}${(draft.tags||[]).filter(a=>a.mediaId===t.id).length||""}</button>`}</div>`).join(""))}function removeAttachment(e){const t=draft.attachments[e]?.id;draft.attachments.splice(e,1),draft.tags=(draft.tags||[]).filter(n=>n.mediaId!==t),renderAttachments()}async function previewAudience(){const e=document.getElementById("compose-audience");try{const t=await api("/reef-api/audience?depth="+draft.privacy+(draft.global?"&all=1":""));audiencePeople=t.people;const n=document.getElementById("compose-audience");if(n){const a=t.people.filter(o=>!draft.excluded.includes(o.id));n.textContent=draft.global?"\u0412\u0441\u0435 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u0438 Reef":a.length?a.length+" \u0447\u0435\u043B\u043E\u0432\u0435\u043A \xB7 "+a.slice(0,3).map(o=>o.name).join(", ")+(a.length>3?"\u2026":""):"\u0412\u0430\u0448\u0438 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u0443 \u0432\u0430\u0441"}}catch{e&&(e.textContent="\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0430\u0443\u0434\u0438\u0442\u043E\u0440\u0438\u044E")}}async function publish(){if(uploading){toast("\u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u0430\u0439\u043B\u043E\u0432");return}const e=draft.text.trim();if(!e&&!draft.attachments.length){toast("\u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442, \u0444\u043E\u0442\u043E \u0438\u043B\u0438 \u0432\u043E\u043F\u0440\u043E\u0441 \u0434\u043B\u044F \u043E\u043F\u0440\u043E\u0441\u0430");return}if(busy.has("publish"))return;busy.add("publish");const t=document.getElementById("publish-button");t.disabled=!0;try{await api("/reef-api/posts"+(draft.id?"/"+draft.id:""),{method:draft.id?"PUT":"POST",body:JSON.stringify({text:e,mediaIds:draft.attachments.map(n=>n.id),depth:draft.privacy,excluded:draft.excluded,global:draft.global,poll:draft.poll,tags:draft.tags||[],commentPolicy:draft.commentPolicy})}),draft=freshDraft(),closeModal(),backToFeed(),await loadFeed(!0),scrollMain(0,0),toast("\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E")}catch(n){toast(n.message),t.isConnected&&(t.disabled=!1)}finally{busy.delete("publish")}}async function prepareImage(e,t=!1){const n=URL.createObjectURL(e);try{const a=new Image;a.src=n,await a.decode();const o=a.naturalWidth,i=a.naturalHeight,s=t?512:1280,r=Math.min(1,s/Math.max(o,i)),l=document.createElement("canvas");l.width=Math.round(o*r),l.height=Math.round(i*r),l.getContext("2d").drawImage(a,0,0,l.width,l.height);let c=.8,u=await new Promise(g=>l.toBlob(g,"image/jpeg",c));for(;u?.size>512*1024&&c>.5;)c-=.1,u=await new Promise(g=>l.toBlob(g,"image/jpeg",c));const m=document.createElement("canvas"),p=Math.min(1,640/Math.max(o,i));m.width=Math.round(o*p),m.height=Math.round(i*p),m.getContext("2d").drawImage(a,0,0,m.width,m.height);let f=.74,b=await new Promise(g=>m.toBlob(g,"image/jpeg",f));for(;b?.size>224*1024&&f>.5;)f-=.1,b=await new Promise(g=>m.toBlob(g,"image/jpeg",f));if(!u||!b)throw Error();return{file:u,thumbnail:b,width:l.width,height:l.height}}catch{throw Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0444\u043E\u0442\u043E. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 JPEG, PNG \u0438\u043B\u0438 WebP.")}finally{URL.revokeObjectURL(n)}}async function prepareVideo(e){const t=document.createElement("video"),n=URL.createObjectURL(e);t.muted=!0,t.playsInline=!0,t.preload="metadata",t.src=n;let a=null,o=null,i=null;try{if(await new Promise((s,r)=>{t.onloadedmetadata=s,t.onerror=r,setTimeout(()=>r(Error("timeout")),5e3)}),o=t.videoWidth,i=t.videoHeight,o&&i){t.preload="auto",await new Promise((l,c)=>{t.onseeked=l,t.onerror=c,t.currentTime=Math.min(.1,t.duration/2||0),setTimeout(c,5e3)});const s=document.createElement("canvas"),r=Math.min(1,480/Math.max(o,i));s.width=Math.round(o*r),s.height=Math.round(i*r),s.getContext("2d").drawImage(t,0,0,s.width,s.height),a=await new Promise(l=>s.toBlob(l,"image/jpeg",.74))}}catch{}finally{t.removeAttribute("src"),t.load(),URL.revokeObjectURL(n)}return{file:e,thumbnail:a,width:o,height:i,video:!0}}function uploadPrepared(e,t){return new Promise((n,a)=>{const o=new FormData;o.append("file",e.file,"upload"),e.video&&(o.append("kind","square"),o.append("duration",e.duration)),e.thumbnail&&o.append("thumbnail",e.thumbnail,"thumbnail.jpg"),e.width&&o.append("width",e.width),e.height&&o.append("height",e.height);const i=new XMLHttpRequest;i.open("POST","/reef-api/media"),i.responseType="json",i.withCredentials=!0,i.upload.onprogress=s=>{s.lengthComputable&&t?.(Math.round(s.loaded/s.total*100))},i.onload=()=>i.status>=200&&i.status<300?n(i.response):a(Error(i.response?.error||"\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u0430\u0439\u043B")),i.onerror=()=>a(Error("\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0443")),i.send(o)})}async function addFiles(e){if(uploading){toast("\u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438");return}const t=[...e];if(draft.attachments.length+t.length>10){toast("\u0412 \u043E\u0434\u043D\u043E\u0439 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u2014 \u0434\u043E 10 \u0444\u0430\u0439\u043B\u043E\u0432");return}uploading=!0,document.getElementById("publish-button")?.setAttribute("disabled","");try{for(let n=0;n<t.length;n++){const a=t[n];if(!a.type.startsWith("image/")){toast("\u0422\u0435\u043F\u0435\u0440\u044C \u043C\u043E\u0436\u043D\u043E \u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0444\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u0438");continue}if(a.size>50*1024*1024){toast("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0444\u043E\u0442\u043E \u0440\u0430\u0437\u043C\u0435\u0440\u043E\u043C \u0434\u043E 50 \u041C\u0411.");continue}const o=document.getElementById("upload-status");setUploadProgress(n+1,t.length,0,"\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u0444\u043E\u0442\u043E");const i=a;if(!i){const l=document.getElementById("upload-status");l&&(l.innerHTML="");continue}const s=await prepareImage(i),r=await uploadPrepared(s,l=>{const c=document.getElementById("upload-status");setUploadProgress(n+1,t.length,l,"\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \u0444\u043E\u0442\u043E")});draft.attachments.push(r),renderAttachments(),setUploadProgress(n+1,t.length,100,"\u0424\u043E\u0442\u043E \u0433\u043E\u0442\u043E\u0432\u043E")}}catch(n){toast(n.message)}finally{uploading=!1,document.getElementById("publish-button")?.removeAttribute("disabled");const n=document.getElementById("upload-status");n&&!draft.attachments.length&&(n.textContent="")}}document.getElementById("file").onchange=e=>{addFiles(e.target.files),e.target.value=""},document.getElementById("camera-file").onchange=e=>{composerOpen||showComposer(),addFiles(e.target.files),e.target.value=""};async function openCamera(){composerOpen=!1,modal("\u041A\u0430\u043C\u0435\u0440\u0430",`<video id="camera-preview" class="camera-preview" autoplay muted playsinline></video><div id="camera-note" class="camera-note"></div><div class="camera-controls"><button onclick="flipCamera()" aria-label="\u0421\u043C\u0435\u043D\u0438\u0442\u044C \u043A\u0430\u043C\u0435\u0440\u0443">${svg("flip")}</button><button class="shutter" onclick="takePhoto()" aria-label="\u0421\u0434\u0435\u043B\u0430\u0442\u044C \u0444\u043E\u0442\u043E">${svg("camera")}</button><button onclick="document.getElementById(\'camera-file\').click()" aria-label="\u041A\u0430\u043C\u0435\u0440\u0430 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430">${svg("image")}</button></div><button class="auth-switch" onclick="showComposer()">\u041A \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438</button>`),await startCamera()}async function startCamera(){try{if(stopCamera(),!navigator.mediaDevices?.getUserMedia)throw Error();cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:cameraFacing},width:{ideal:1600}},audio:!1});const e=document.getElementById("camera-preview");if(!e){stopCamera();return}e.srcObject=cameraStream,await e.play()}catch{const e=document.getElementById("camera-note");e&&(e.innerHTML=`\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043A\u0430\u043C\u0435\u0440\u0435 \u0438\u043B\u0438 <button class="auth-switch" onclick="document.getElementById(\'camera-file\').click()">\u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043A\u0430\u043C\u0435\u0440\u0443 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430</button>`)}}async function flipCamera(){cameraFacing=cameraFacing==="environment"?"user":"environment",await startCamera()}async function takePhoto(){const e=document.getElementById("camera-preview");if(!e?.videoWidth){toast("\u041A\u0430\u043C\u0435\u0440\u0430 \u0435\u0449\u0451 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u0430");return}const t=document.createElement("canvas"),n=Math.min(1,1600/Math.max(e.videoWidth,e.videoHeight));t.width=Math.round(e.videoWidth*n),t.height=Math.round(e.videoHeight*n),t.getContext("2d").drawImage(e,0,0,t.width,t.height);const a=await new Promise(o=>t.toBlob(o,"image/jpeg",.85));showComposer(),await addFiles([new File([a],"camera.jpg",{type:"image/jpeg"})])}async function showPrivacy(){composerOpen=!1;try{audiencePeople=(await api("/reef-api/audience?depth=3"+(draft.global?"&all=1":""))).people,modal("\u041A\u0442\u043E \u0443\u0432\u0438\u0434\u0438\u0442 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E",`<label>\u0413\u043B\u0443\u0431\u0438\u043D\u0430 \u0437\u043D\u0430\u043A\u043E\u043C\u0441\u0442\u0432</label><select id="privacy" onchange="updateAudience()">${[1,2,3].map(e=>`<option value="${e}" ${draft.privacy===e?"selected":""}>\u0414\u043E ${e}-\u0433\u043E \u043A\u0440\u0443\u0433\u0430</option>`).join("")}</select><label>\u0421\u043A\u0440\u044B\u0442\u044C \u043E\u0442</label>${audiencePeople.map(e=>`<label class="check"><input type="checkbox" name="excluded" onchange="updateAudience()" value="${e.id}" ${draft.excluded.includes(e.id)?"checked":""}>${esc(e.name)}</label>`).join("")||"<p>\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0440\u0443\u0433\u0438\u0445 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432</p>"}<label>\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E \u0443\u0432\u0438\u0434\u044F\u0442</label><div id="audienceList" class="sub"></div><button class="primary" onclick="savePrivacy()">\u0413\u043E\u0442\u043E\u0432\u043E</button><button class="auth-switch" onclick="showComposer()">\u041D\u0430\u0437\u0430\u0434</button>`),updateAudience()}catch(e){toast(e.message)}}function updateAudience(){const e=+document.getElementById("privacy").value,t=[...document.querySelectorAll("[name=excluded]:checked")].map(n=>n.value);document.getElementById("audienceList").innerHTML=audiencePeople.filter(n=>(draft.global||n.degree<=e)&&!t.includes(n.id)).map(n=>esc(n.name)).join("<br>")||"\u0422\u043E\u043B\u044C\u043A\u043E \u0432\u044B"}function savePrivacy(){draft.privacy=+document.getElementById("privacy").value,draft.excluded=[...document.querySelectorAll("[name=excluded]:checked")].map(e=>e.value),showComposer()}async function showFilters(){try{const e=await api("/reef-api/audience?depth=3");audiencePeople=e.people,modal("\u0412\u0430\u0448\u0430 \u043B\u0435\u043D\u0442\u0430",`<p class="filter-intro">\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435, \u043D\u0430\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0448\u0438\u0440\u043E\u043A\u0438\u043C \u0431\u0443\u0434\u0435\u0442 \u0432\u0430\u0448 \u043A\u0440\u0443\u0433.</p><div class="depth-cards">${[1,2,3].map(t=>`<label class="depth-card"><input type="radio" name="feed-depth" value="${t}" ${state.depth===t?"checked":""}><span class="depth-card-icon">${svg("users")}</span><span><strong>${["\u0414\u0440\u0443\u0437\u044C\u044F","\u0414\u0440\u0443\u0437\u044C\u044F \u0434\u0440\u0443\u0437\u0435\u0439","\u0422\u0440\u0438 \u043A\u0440\u0443\u0433\u0430"][t-1]}</strong><small>${["\u0422\u043E\u043B\u044C\u043A\u043E \u0431\u043B\u0438\u0437\u043A\u0438\u0439 \u043A\u0440\u0443\u0433","\u0417\u043D\u0430\u043A\u043E\u043C\u044B\u0435 \u0432\u0430\u0448\u0438\u0445 \u0434\u0440\u0443\u0437\u0435\u0439","\u0412\u0441\u0435 \u0441\u0432\u044F\u0437\u0438 \u0434\u043E \u0442\u0440\u0435\u0442\u044C\u0435\u0433\u043E \u043A\u0440\u0443\u0433\u0430"][t-1]}</small></span><span class="depth-radio"></span></label>`).join("")}</div><details class="muted-authors"><summary>\u0421\u043A\u0440\u044B\u0442\u044B\u0435 \u0430\u0432\u0442\u043E\u0440\u044B <span>${state.muted.length||""}</span></summary><div class="muted-authors-list">${e.people.map(t=>`<label class="check"><input type="checkbox" name="muted" value="${t.id}" ${state.muted.includes(t.id)?"checked":""}>${esc(t.name)}</label>`).join("")||"<p>\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0440\u0443\u0433\u0438\u0445 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432</p>"}</div></details><button class="primary" onclick="saveFilters()">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>`,"filters-modal")}catch(e){toast(e.message)}}async function saveFilters(){try{const e=Number(document.querySelector("[name=feed-depth]:checked").value),t=[...document.querySelectorAll("input[name=muted]:checked")].map(n=>n.value);await api("/reef-api/preferences",{method:"PUT",body:JSON.stringify({depth:e,muted:t})}),state.depth=e,state.muted=t,closeModal(),backToFeed(),await loadFeed(!0)}catch(e){toast(e.message)}}async function showInvite(e="link"){if(!invitePending)try{let t;if(!inviteLink||Date.now()/1e3>=inviteExpiry){if(t=await api("/reef-api/invites"),t.limit&&t.used>=t.limit){showInviteManager(t);return}invitePending=!0;const n=await api("/reef-api/invites",{method:"POST",body:"{}"});inviteLink=n.url,inviteCode=n.code||"",inviteExpiry=n.expires}if(t=await api("/reef-api/invites"),modal("\u041F\u0440\u0438\u0433\u043B\u0430\u0441\u0438\u0442\u044C \u0432 Reef",`<div class="invite-mode"><button class="${e==="link"?"active":""}" onclick="showInvite(\'link\')">\u0421\u0441\u044B\u043B\u043A\u0430</button><button class="${e==="qr"?"active":""}" onclick="showInvite(\'qr\')">QR-\u043A\u043E\u0434</button><button class="${e==="code"?"active":""}" onclick="showInvite(\'code\')">\u041A\u043E\u0434</button></div>${e==="code"?`<div class="friend-invite-code">${esc(inviteCode||"\u0421\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u043D\u043E\u0432\u0443\u044E \u0441\u0441\u044B\u043B\u043A\u0443, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043A\u043E\u0434")}</div>`:""}${e==="qr"?\'<div id="invite-qr" class="invite-qr" role="img" aria-label="QR-\u043A\u043E\u0434 \u043F\u0440\u0438\u0433\u043B\u0430\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0439 \u0441\u0441\u044B\u043B\u043A\u0438"></div>\':""}${inviteQuotaHTML(t)}<input id="invite-link" class="invite-link" readonly aria-label="\u041F\u0440\u0438\u0433\u043B\u0430\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430" value="${esc(inviteLink)}" onclick="this.select()"><button class="primary" onclick="copyInvite(this)" data-copy-invite data-copy-kind="${e==="code"?"code":"link"}">${e==="code"?"\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043A\u043E\u0434":"\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0441\u044B\u043B\u043A\u0443"}</button><p class="invite-note">\u0414\u043B\u044F \u043E\u0434\u043D\u043E\u0433\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430. \u0414\u0435\u0439\u0441\u0442\u0432\u0443\u0435\u0442 7 \u0434\u043D\u0435\u0439. \u041D\u0435\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043D\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430 \u043D\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u0443\u0435\u0442 \u043B\u0438\u043C\u0438\u0442.</p><button class="auth-switch" style="display:block;margin:16px auto 0" onclick="newInvite()">\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0434\u0440\u0443\u0433\u0443\u044E \u0441\u0441\u044B\u043B\u043A\u0443</button>`),e==="qr"){const n=qrcode(0,"M");n.addData(inviteLink),n.make(),document.getElementById("invite-qr").innerHTML=n.createSvgTag({cellSize:6,margin:24,scalable:!0})}}catch(t){toast(t.message)}finally{invitePending=!1}}function newInvite(){inviteLink="",inviteCode="",showInvite()}async function copyInvite(e){if(!(Date.now()<copyReadyAt||busy.has("copy-invite"))){busy.add("copy-invite");try{await navigator.clipboard.writeText(document.querySelector(`.invite-mode [onclick="showInvite(\'code\')"].active`)&&inviteCode?inviteCode:inviteLink),copyReadyAt=Date.now()+2200,document.querySelectorAll("[data-copy-invite]").forEach(t=>{t.disabled=!0,t.classList.add("copy-done"),t.innerHTML=svg("check")+"<span>"+(t.dataset.copyKind==="code"?"\u041A\u043E\u0434 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D":"\u0421\u0441\u044B\u043B\u043A\u0430 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0430")+"</span>"}),setTimeout(()=>{copyReadyAt=0,document.querySelectorAll("[data-copy-invite]").forEach(t=>{t.disabled=!1,t.classList.remove("copy-done"),t.textContent=t.dataset.copyKind==="code"?"\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043A\u043E\u0434":"\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0441\u044B\u043B\u043A\u0443"})},2200)}catch{const t=document.getElementById("invite-link");t?.focus(),t?.select(),e&&(e.textContent="\u0421\u043A\u043E\u043F\u0438\u0440\u0443\u0439\u0442\u0435 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u0443\u044E \u0441\u0441\u044B\u043B\u043A\u0443")}finally{busy.delete("copy-invite")}}}function viewbar(e,t=""){return queueScreenAnimation(),`<div class="viewbar"><button onclick="${view==="notifications"?"openProfile(me.id)":["admin","requests"].includes(view)?"returnToSettings()":view==="chat"?"openInbox()":"backToFeed()"}" aria-label="${view==="notifications"?"\u041A \u043F\u0440\u043E\u0444\u0438\u043B\u044E":["admin","requests"].includes(view)?"\u041A \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u043C":view==="chat"?"\u041A \u0447\u0430\u0442\u0430\u043C":"\u0412 \u043B\u0435\u043D\u0442\u0443"}">${svg("back")}</button><h1>${esc(e)}</h1>${t||\'<span style="width:40px"></span>\'}</div>`}async function openProfile(e){closeModal();const t=++loadGeneration;loading=!1;try{const[n,a]=await Promise.all([api("/reef-api/profiles/"+e),api("/reef-api/profiles/"+e+"/posts?limit=9").catch(o=>({error:o.message}))]);if(t!==loadGeneration)return;profile=n.profile,profilePosts=a.posts||[],profileNext=a.next||null,view="profile",rememberRoute("profile",e),actions(),renderProfile(),scrollMain(0,0),a.error&&setLoading(!1)}catch(n){toast(n.message)}}function renderProfile(){const e=profile.own?"\u0412\u0430\u0448 \u043F\u0440\u043E\u0444\u0438\u043B\u044C":profile.friend?"\u0412\u044B \u0434\u0440\u0443\u0437\u044C\u044F":profile.mutual.length?"\u041E\u0431\u0449\u0438\u0435 \u0434\u0440\u0443\u0437\u044C\u044F: "+profile.mutual.map(t=>t.name).join(", "):profile.chain.length?"\u0417\u043D\u0430\u043A\u043E\u043C\u044B \u0447\u0435\u0440\u0435\u0437 "+profile.chain.map(t=>t.name).join(" \u2192 "):"\u041E\u0431\u0449\u0438\u0445 \u0437\u043D\u0430\u043A\u043E\u043C\u044B\u0445 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442";main.innerHTML=viewbar(profile.own?"\u041C\u043E\u0439 \u043F\u0440\u043E\u0444\u0438\u043B\u044C":"\u041F\u0440\u043E\u0444\u0438\u043B\u044C",profile.own?`<button onclick="openAccountMenu()" aria-label="\u041C\u0435\u043D\u044E">${svg("settings")}</button>`:"")+`<section class="profile-hero">${profile.avatar?`<button class="avatar-open" onclick="openAvatar()" aria-label="\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0430\u0432\u0430\u0442\u0430\u0440\u043A\u0443">${avatar(profile,"profile-avatar")}</button>`:avatar(profile,"profile-avatar")}<div class="profile-name">${esc(profile.name)}${customBadgesHTML(profile.badges)}${profile.telegramVerified?verifiedBadge():""}${profile.staffRole||profile.admin?staffBadge(profile.staffRole||"admin"):""}</div>${profile.bio?`<p class="profile-bio">${esc(profile.bio)}</p>`:""}<p class="profile-presence"><span class="presence-dot ${(profile.online||profile.own)&&!(profile.own&&me?.invisible)?"online":""}"></span><span id="profile-presence-text">${presenceLabel(profile)}</span></p><p class="profile-relation">${esc(e)}</p><button class="friends-count" onclick="openFriendsList(\'${profile.id}\')">${profile.friendsCount||0} ${friendWord(profile.friendsCount||0)}</button><div class="profile-buttons">${profile.own?`<button onclick="editProfile()">${svg("edit")}\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C</button><button class="profile-notifications" onclick="openNotifications()" aria-label="\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F" title="\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F">${svg("bell")}${notificationsUnread?`<span class="notification-count">${notificationsUnread}</span>`:""}</button>`:`${friendControls(profile)}<button onclick="openChat(\'${profile.id}\')">${svg("comment")}\u041D\u0430\u043F\u0438\u0441\u0430\u0442\u044C</button>`}</div>${profile.own?profileTools():""}</section><div class="profile-grid" id="profile-grid">${profilePosts.map(gridTile).join("")}</div>`+sentinel(profileNext),observe()}function gridTile(e){const t=e.media?.[0];return`<button class="grid-tile" onclick="openPost(\'${e.id}\')" aria-label="\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E">${t?.thumbnail||t?.type.startsWith("image/")?`<img data-src="${esc(t.thumbnail||t.url)}" loading="lazy" decoding="async" alt="\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F ${esc(e.name)}">`:`<div class="grid-text">${t?svg("video"):esc(e.text.slice(0,100))}</div>`}${t?.type.startsWith("video/")||e.media?.length>1?`<span class="grid-label">${t?.type.startsWith("video/")?"\u25B6":"\u25A3"}</span>`:""}</button>`}async function loadProfilePosts(e=!1){if(loading&&!e||!e&&!profileNext)return;loading=!0;const t=profile.id,n=loadGeneration;setLoading(!0);try{const a=await api("/reef-api/profiles/"+t+"/posts?limit=9"+(!e&&profileNext?"&cursor="+encodeURIComponent(profileNext):""));if(view!=="profile"||profile.id!==t||n!==loadGeneration)return;const o=new Set(profilePosts.map(s=>s.id)),i=a.posts.filter(s=>!o.has(s.id));profilePosts.push(...i),profileNext=a.next,document.getElementById("profile-grid").insertAdjacentHTML("beforeend",i.map(gridTile).join("")),document.getElementById("page-sentinel")?.replaceWith(htmlNode(sentinel(profileNext))),observe()}catch(a){toast(a.message),setLoading(!1)}finally{n===loadGeneration&&(loading=!1)}}async function editProfile(){editProfileData={name:profile.name,bio:profile.bio||"",avatar:profile.avatarId||null,preview:profile.avatar},modal("\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0440\u043E\u0444\u0438\u043B\u044C",`<button class="avatar-edit" onclick="document.getElementById(\'avatar-file\').click()" aria-label="\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0430\u0432\u0430\u0442\u0430\u0440\u043A\u0443" id="avatar-edit">${profile.avatar?`<img src="${esc(profile.avatar)}" alt="\u0410\u0432\u0430\u0442\u0430\u0440\u043A\u0430">`:`<span>${svg("camera")}</span>`}</button><button class="change-avatar-button" onclick="document.getElementById(\'avatar-file\').click()">\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0444\u043E\u0442\u043E</button><label>\u0418\u043C\u044F</label><input class="profile-name-input" maxlength="60" id="profile-name" value="${esc(profile.name)}" oninput="editProfileData.name=this.value"><label>\u041E \u0441\u0435\u0431\u0435</label><textarea class="bio-input" maxlength="240" id="profile-bio" oninput="editProfileData.bio=this.value">${esc(profile.bio||"")}</textarea><button class="primary" onclick="saveProfile()">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>`)}document.getElementById("avatar-file").onchange=async e=>{const t=e.target.files[0];if(t)try{toast("\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \u0430\u0432\u0430\u0442\u0430\u0440\u043A\u0443\u2026");const n=await uploadPrepared(await prepareImage(t,!0));editProfileData.avatar=n.id,editProfileData.preview=n.thumbnail||n.url;const a=document.getElementById("avatar-edit");a&&(a.innerHTML=`<img src="${esc(editProfileData.preview)}" alt="\u0410\u0432\u0430\u0442\u0430\u0440\u043A\u0430">`)}catch(n){toast(n.message)}finally{e.target.value=""}};async function saveProfile(){if(!busy.has("profile")){busy.add("profile");try{await api("/reef-api/profile",{method:"PUT",body:JSON.stringify({name:editProfileData.name,bio:editProfileData.bio,avatar:editProfileData.avatar})}),me.name=editProfileData.name,me.bio=editProfileData.bio,me.avatar=editProfileData.preview;for(const e of state.posts)e.author===me.id&&(e.name=me.name,e.avatar=me.avatar);closeModal(),await openProfile(me.id)}catch(e){toast(e.message)}finally{busy.delete("profile")}}}async function addFriend(e){const t="friend:"+e;if(!busy.has(t)){busy.add(t);try{const n=await api("/reef-api/friends",{method:"POST",body:JSON.stringify({member:e})});closeModal(),(view==="profile"||n.status==="incoming")&&await openProfile(e),toast(n.status==="friends"?"\u0412\u044B \u0443\u0436\u0435 \u0434\u0440\u0443\u0437\u044C\u044F":n.status==="incoming"?"\u0423 \u0432\u0430\u0441 \u0435\u0441\u0442\u044C \u0432\u0445\u043E\u0434\u044F\u0449\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430 \u043E\u0442 \u044D\u0442\u043E\u0433\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430":"\u0417\u0430\u044F\u0432\u043A\u0430 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430"),checkUpdates().catch(()=>{})}catch(n){toast(n.message)}finally{busy.delete(t)}}}async function openPost(e){try{detailPost=(await api("/reef-api/posts/"+e)).post;for(const t of[state.posts,profilePosts]){const n=t.find(a=>a.id===e);n&&Object.assign(n,detailPost)}modal("\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F",postHTML(detailPost),"detail-modal"),observe(document.getElementById("modalroot"))}catch(t){toast(t.message)}}function postMenu(e){const t=findPost(e);modal("\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F",t.author===me.id?`<div class="post-actions"><button onclick="editPost(\'${e}\')">${svg("edit")}<span><strong>\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E</strong><small>\u0422\u0435\u043A\u0441\u0442, \u0444\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u0438 \u0438 \u0430\u0443\u0434\u0438\u0442\u043E\u0440\u0438\u044F</small></span>${svg("chevron")}</button><button class="danger" onclick="confirmDeletePost(\'${e}\')">${svg("trash")}<span><strong>\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E</strong><small>\u041C\u043E\u043C\u0435\u043D\u0442 \u0438\u0441\u0447\u0435\u0437\u043D\u0435\u0442 \u0438\u0437 Reef</small></span></button></div>`:`<div class="post-actions"><button onclick="openProfile(\'${t.author}\')">${svg("user")}<span><strong>\u041F\u0440\u043E\u0444\u0438\u043B\u044C \u0430\u0432\u0442\u043E\u0440\u0430</strong></span>${svg("chevron")}</button><button onclick="muteAuthor(\'${t.author}\')">${svg("eye")}<span><strong>\u0421\u043A\u0440\u044B\u0442\u044C \u0430\u0432\u0442\u043E\u0440\u0430 \u0438\u0437 \u043B\u0435\u043D\u0442\u044B</strong></span></button></div>`)}async function editPost(e){if(!uploading)try{const t=(await api("/reef-api/posts/"+e)).post;draft={id:t.id,text:t.text,attachments:t.media,privacy:t.audience,excluded:t.excluded,global:!!t.global,poll:t.poll?.options.map(n=>n.text)||null,tags:t.tags||[],commentPolicy:t.commentPolicy||{depth:4,excluded:[]}},showComposer()}catch(t){toast(t.message)}}async function deletePost(e){try{await api("/reef-api/posts/"+e,{method:"DELETE"}),closeModal(),backToFeed(),await loadFeed(!0)}catch(t){toast(t.message)}}async function muteAuthor(e){try{const t=[...new Set([...state.muted,e])];await api("/reef-api/preferences",{method:"PUT",body:JSON.stringify({depth:state.depth,muted:t})}),state.muted=t,closeModal(),backToFeed(),await loadFeed(!0)}catch(t){toast(t.message)}}async function openInbox(){closeModal();const e=++loadGeneration;loading=!1;try{const t=await api("/reef-api/messages");if(e!==loadGeneration)return;view="inbox",rememberRoute("inbox"),actions(),main.innerHTML=viewbar("\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F")+t.chats.map(n=>`<button class="chat-row" onclick="openChat(\'${n.member}\',true)">${avatar(n)}<div class="chat-summary"><strong>${esc(n.name)}</strong><p>${esc(n.text)}</p></div>${n.unread?\'<span class="unread-dot"></span>\':""}</button>`).join(""),t.chats.length||main.insertAdjacentHTML("beforeend",\'<div class="empty">\u0417\u0434\u0435\u0441\u044C \u0431\u0443\u0434\u0443\u0442 \u0432\u0430\u0448\u0438 \u0434\u0438\u0430\u043B\u043E\u0433\u0438.<br>\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043F\u0440\u043E\u0444\u0438\u043B\u044C \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041D\u0430\u043F\u0438\u0441\u0430\u0442\u044C\xBB.</div>\'),scrollMain(0,0)}catch(t){toast(t.message)}}async function openChat(e,t=!1){closeModal();const n=++loadGeneration;loading=!1;try{const a=(await api("/reef-api/profiles/"+e)).profile;if(n!==loadGeneration)return;if(a.messagingAllowed===!1&&!t){showMessageRestriction();return}view="chat",actions(),activeChat=a,rememberRoute("chat",e),chatMessages=[],lastChatKey="",main.innerHTML=viewbar(a.name)+`<div class="chat-thread" id="chat-thread"></div><form class="chat-input" onsubmit="sendMessage(event)"><input ${a.messagingAllowed===!1?"disabled":""} name="message" maxlength="2000" required placeholder="\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435\u2026" aria-label="\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435"><button ${a.messagingAllowed===!1?"disabled":""} aria-label="\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C">${svg("send")}</button>${a.messagingAllowed===!1?\'<button type="button" class="chat-permission-info" onclick="showMessageRestriction()" aria-label="\u041F\u043E\u0447\u0435\u043C\u0443 \u043D\u0435\u043B\u044C\u0437\u044F \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C">?</button>\':""}</form>`,await refreshChat(!0)}catch(a){toast(a.message)}}function bubbles(e){return e.map((t,n)=>`${messageDateHTML(t,e[n-1])}<div class="bubble ${t.sender===me.id?"own":""}" data-message-id="${t.id}"><div class="message-text">${esc(t.text)}</div><div class="message-meta"><button class="message-like ${t.liked?"liked":""}" aria-label="\u041D\u0440\u0430\u0432\u0438\u0442\u0441\u044F \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435" aria-pressed="${!!t.liked}" onclick="likeMessage(\'${t.id}\')">${svg("heart")}<span>${t.likes||""}</span></button><time>${new Date(t.created*1e3).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</time></div></div>`).join("")}async function refreshChat(e=!1){if(view!=="chat"||!activeChat)return;const t=activeChat.id;try{const n=await api("/reef-api/messages/"+t);if(view!=="chat"||activeChat.id!==t)return;const a=n.messages.map(o=>o.id+":"+o.likes+":"+o.liked).join(",");if(a!==lastChatKey){const o=new Set(n.messages.map(i=>i.id));chatMessages=[...chatMessages.filter(i=>!o.has(i.id)),...n.messages],chatNext||(chatNext=n.next),lastChatKey=a,document.getElementById("chat-thread").innerHTML=(chatNext?\'<button class="auth-switch" onclick="olderMessages()">\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F</button>\':"")+bubbles(chatMessages),e&&scrollMain(0,main.scrollHeight)}}catch(n){e&&toast(n.message)}}async function olderMessages(){if(chatNext)try{const e=await api("/reef-api/messages/"+activeChat.id+"?before="+chatNext);chatMessages=[...e.messages,...chatMessages],chatNext=e.next;const t=main.scrollTop,n=main.scrollHeight;document.getElementById("chat-thread").innerHTML=(e.next?\'<button class="auth-switch" onclick="olderMessages()">\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F</button>\':"")+bubbles(chatMessages),scrollMain(0,t+main.scrollHeight-n)}catch(e){toast(e.message)}}async function sendMessage(e){if(e.preventDefault(),busy.has("send"))return;const t=e.target.message.value.trim();if(!t)return;busy.add("send");const n=e.target.querySelector("button");n.disabled=!0;try{await api("/reef-api/messages/"+activeChat.id,{method:"POST",body:JSON.stringify({text:t})}),e.target.message.value="",await refreshChat(!0)}catch(a){toast(a.message)}finally{busy.delete("send"),n.disabled=!1}}async function logout(){try{await disconnectPush(!0),await api("/reef-api/auth/logout",{method:"POST",body:"{}"}),me=null,topNoticeBaseline=null,topNoticeQueue=[],animationQueue=[],document.querySelectorAll(".top-notice,.friend-celebration").forEach(e=>e.remove()),state.posts=[],feedPosition=null,commentCache.clear(),commentReplies.clear(),peoplePanel=null,tagEditor=null,inviteLink="",draft=freshDraft(),feedReady=!1,closeModal(),showAuth()}catch(e){toast(e.message)}}let lightboxPost=null,lightboxIndex=0;function openPhoto(e,t=0){const n=findPost(e);n?.media?.length&&(lightboxPost=n,lightboxIndex=t,lastFocus=document.activeElement,paintLightbox())}function stepPhoto(e){lightboxIndex=(lightboxIndex+e+lightboxPost.media.length)%lightboxPost.media.length,paintLightbox()}function closePhoto(){photoZoom?.pointers?.clear(),document.getElementById("lightboxroot").innerHTML="",document.body.style.overflow=document.getElementById("modalroot").innerHTML?"hidden":"",syncNavigationLayer(),lastFocus?.focus?.()}document.addEventListener("keydown",e=>{if(e.key==="Escape"&&(document.getElementById("lightboxroot").innerHTML?closePhoto():closeModal()),document.getElementById("lightboxroot").innerHTML&&lightboxPost&&["ArrowLeft","ArrowRight"].includes(e.key)&&stepPhoto(e.key==="ArrowRight"?1:-1),e.key==="Tab"){const t=document.querySelector(".lightbox")||document.querySelector(".modal");if(!t)return;const n=[...t.querySelectorAll("button,input,select,textarea,video[controls]")].filter(i=>!i.disabled),a=n[0],o=n.at(-1);e.shiftKey&&document.activeElement===a?(e.preventDefault(),o?.focus()):!e.shiftKey&&document.activeElement===o&&(e.preventDefault(),a?.focus())}});let toastTimer;function toast(e){document.querySelector(".toast")?.remove();const t=document.createElement("div");t.className="toast",t.setAttribute("role","status"),t.textContent=e,document.body.append(t),clearTimeout(toastTimer),toastTimer=setTimeout(()=>t.remove(),4500)}let liveTicks=0;setInterval(()=>{me&&document.visibilityState==="visible"&&(view==="chat"&&refreshChat(),syncLivePosts().catch(()=>{}),++liveTicks%2===0&&(checkUpdates().catch(()=>{}),refreshProfilePresence().catch(()=>{})),liveTicks%3===0&&syncFeed().catch(()=>{}),liveTicks%4===0&&updatePresence(!0).catch(()=>{}))},6e3),document.addEventListener("visibilitychange",()=>{document.visibilityState!=="visible"?(stopCamera(),markOffline()):me&&(updatePresence(!0).catch(()=>{}),view==="chat"&&refreshChat(),syncLivePosts().catch(()=>{}),checkUpdates().catch(()=>{}))}),window.addEventListener("pagehide",()=>{stopCamera(),markOffline()}),applyTheme(),hydrate(),showActions(!1),boot(),"serviceWorker"in navigator&&navigator.serviceWorker.register("/sw.js").catch(()=>{});function startPost(){draft.id&&(draft=freshDraft()),showComposer()}function showInviteManager(e){modal("\u041F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F",`${inviteQuotaHTML(e)}<p>\u041B\u0438\u043C\u0438\u0442 \u043C\u043E\u0436\u043D\u043E \u0443\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C \u0443 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430.</p>${e.pending.map((t,n)=>`<div class="rightlink" style="display:flex;align-items:center;justify-content:space-between;padding:12px 0"><span>\u0414\u0435\u0439\u0441\u0442\u0432\u0443\u044E\u0449\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430 ${n+1}</span><button class="auth-switch" style="margin:0" onclick="revokeInvite(\'${t.id}\')">\u041E\u0442\u043E\u0437\u0432\u0430\u0442\u044C</button></div>`).join("")||"<p>\u0412\u0441\u0435 \u043C\u0435\u0441\u0442\u0430 \u0437\u0430\u043D\u044F\u0442\u044B \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0451\u043D\u043D\u044B\u043C\u0438 \u0434\u0440\u0443\u0437\u044C\u044F\u043C\u0438.</p>"}<p class="invite-note">\u041D\u0435\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0435 \u0441\u0441\u044B\u043B\u043A\u0438 \u043D\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u0443\u044E\u0442 \u043B\u0438\u043C\u0438\u0442. \u0423\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F \u043D\u043E\u0432\u044B\u0445 \u0434\u0440\u0443\u0437\u0435\u0439.</p>`)}async function revokeInvite(e){try{await api("/reef-api/invites/"+e,{method:"DELETE"}),inviteLink="";const t=await api("/reef-api/invites");t.limit&&t.used>=t.limit?showInviteManager(t):(closeModal(),toast("\u0421\u0441\u044B\u043B\u043A\u0430 \u043E\u0442\u043E\u0437\u0432\u0430\u043D\u0430."))}catch(t){toast(t.message)}}let themeTransitionTimer;function applyTheme(e){e&&!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches&&(clearTimeout(themeTransitionTimer),document.documentElement.classList.add("theme-transition"),document.documentElement.offsetWidth,themeTransitionTimer=setTimeout(()=>document.documentElement.classList.remove("theme-transition"),600));let t=e;try{t=t||localStorage.getItem("reef-theme")||"light",e&&localStorage.setItem("reef-theme",e)}catch{}document.documentElement.dataset.theme=t||"light";const n=document.querySelector(\'meta[name="theme-color"]\');n&&(n.content=t==="dark"?"#24212a":"#ffffff")}function toggleTheme(){if(applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark"),view==="profile"&&profile?.own){const t=document.querySelector(".profile-tools");t&&(t.outerHTML=profileTools(),hydrate())}const e=document.querySelector(\'.account-menu [onclick="toggleTheme()"]\');if(e){const t=document.documentElement.dataset.theme==="dark";e.innerHTML=svg(t?"sun":"moon")+"<span>"+(t?"\u0421\u0432\u0435\u0442\u043B\u0430\u044F \u0442\u0435\u043C\u0430":"\u0422\u0451\u043C\u043D\u0430\u044F \u0442\u0435\u043C\u0430")+"</span>"}}let requestsUnread=0,notificationsUnread=0,notificationsNext=null,adminNext=null,adminQuery="",animationBusy=!1,animationQueue=[];function profileTools(){return""}function friendMemory(){try{return JSON.parse(localStorage.getItem("reef-friend-events-"+me.id)||"[]")}catch{return[]}}function rememberFriend(e){if(me)try{const t=friendMemory();t.includes(e)||t.push(e),localStorage.setItem("reef-friend-events-"+me.id,JSON.stringify(t.slice(-100)))}catch{}}function celebrateFriend(e){animationQueue.push(e),animationQueue.length>3&&(animationQueue=animationQueue.slice(-3)),runFriendAnimation()}function runFriendAnimation(){if(animationBusy||!animationQueue.length||!me)return;animationBusy=!0;const e=animationQueue.shift(),t=document.createElement("div");t.className="friend-celebration",t.setAttribute("role","status"),t.innerHTML=`<div class="friend-stage"><div class="friend-left">${avatar(me)}</div><div class="friend-rings"><span class="friend-ring"></span><span class="friend-ring second"></span></div><div class="friend-right">${avatar(e)}</div></div><div class="friend-caption">${e.id?`\u0422\u0435\u043F\u0435\u0440\u044C \u0432\u044B \u0441 <strong>${esc(e.name)}</strong> \u0432 \u043E\u0434\u043D\u043E\u043C \u043A\u0440\u0443\u0433\u0435`:"\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C \u0432 <strong>Reef</strong>"}</div>`,document.body.append(t),setTimeout(()=>{t.remove(),animationBusy=!1,runFriendAnimation()},3800)}async function checkUpdates(){if(!me)return null;const e=await api("/reef-api/updates");notificationsUnread=e.unread;const t=document.querySelector(".profile-notifications");t&&(t.innerHTML=svg("bell")+(notificationsUnread?`<span class="notification-count">${notificationsUnread}</span>`:"")),requestsUnread=e.requests||0,["normal","screen"].includes(e.feedMode)&&(me.feedMode=e.feedMode,document.activeElement?.matches?.("input,textarea")||applyFeedMode()),handleTopNotices(e.events||[]),document.querySelector(".inbox-button")?.classList.toggle("unread",e.messages>0),document.querySelector(".profile-button")?.classList.toggle("has-notices",e.unread>0);const n=friendMemory(),a=(e.friends||[]).filter(o=>!n.includes(o.id));for(const o of a)rememberFriend(o.id);for(const o of a.slice(0,3).reverse())celebrateFriend({...o,id:o.actor});if(view==="profile"&&profile?.own){const o=document.querySelector(".profile-tools");o&&(o.outerHTML=profileTools())}return e}async function afterLogin(){updatePresence(!0).catch(()=>{}),restoreDevicePush().catch(()=>{});let e=!1;try{e=!localStorage.getItem("reef-welcome-"+me.id),localStorage.setItem("reef-welcome-"+me.id,"1")}catch{}try{const t=await checkUpdates();e&&!t?.friends?.length&&celebrateFriend({name:"Reef"})}catch{e&&celebrateFriend({name:"Reef"})}}async function likeComment(e,t){const n="cl:"+t;if(busy.has(n))return;const a=commentCache.get(e)?.find(o=>o.id===t);if(a){busy.add(n),pulseLike(`[data-comment-like="${t}"]`);try{const o=await api("/reef-api/comments/"+t+"/likes",{method:"PUT",body:JSON.stringify({liked:!a.liked})});a.likes=o.likes,a.liked=o.liked;const i=findPost(e);i&&(i._liveVersion=(i._liveVersion||0)+1),document.querySelectorAll(`[data-comment-like="${t}"]`).forEach(s=>{s.classList.toggle("liked",o.liked),s.setAttribute("aria-pressed",o.liked),s.querySelector("span").textContent=o.likes||""})}catch(o){toast(o.message)}finally{busy.delete(n)}}}const notificationText={test:"\u041F\u0440\u043E\u0432\u0435\u0440\u043E\u0447\u043D\u043E\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 Reef",friend_request:"\u0445\u043E\u0447\u0435\u0442 \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0432\u0430\u0441 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F",invite_joined:"\u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043B\u0441\u044F(\u0430\u0441\u044C) \u043F\u043E \u0432\u0430\u0448\u0435\u043C\u0443 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044E",friend:"\u0442\u0435\u043F\u0435\u0440\u044C \u0432\u0430\u0448 \u0434\u0440\u0443\u0433",like:"\u043D\u0440\u0430\u0432\u0438\u0442\u0441\u044F \u0432\u0430\u0448\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F",comment:"\u043F\u0440\u043E\u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043B(\u0430) \u0432\u0430\u0448\u0443 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E",reply:"\u043E\u0442\u0432\u0435\u0442\u0438\u043B(\u0430) \u043D\u0430 \u0432\u0430\u0448 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439",photo_tag:"\u043E\u0442\u043C\u0435\u0442\u0438\u043B(\u0430) \u0432\u0430\u0441 \u043D\u0430 \u0444\u043E\u0442\u043E",tag_comment:"\u043E\u0441\u0442\u0430\u0432\u0438\u043B(\u0430) \u043F\u043E\u0434\u043F\u0438\u0441\u044C \u043D\u0430 \u0444\u043E\u0442\u043E",comment_like:"\u043D\u0440\u0430\u0432\u0438\u0442\u0441\u044F \u0432\u0430\u0448 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439",message:"\u043D\u0430\u043F\u0438\u0441\u0430\u043B(\u0430) \u0432\u0430\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435"};function notificationHTML(e){return`<div class="notice-row ${e.seen?"":"unseen"}"><button class="notice-main" onclick="openNotice(\'${e.kind}\',\'${esc(e.actor)}\',\'${esc(e.post||"")}\')">${avatar(e)}<div class="notice-copy"><strong>${esc(e.name)}</strong> ${notificationText[e.kind]||"\u0432 \u0432\u0430\u0448\u0435\u043C \u043A\u0440\u0443\u0433\u0435"}<small>${dateLabel(e.created)}</small></div></button>${e.kind==="friend_request"?`<div class="friend-request-actions"><button class="accept-friend" onclick="respondFriend(\'${e.actor}\',true)">\u041F\u0440\u0438\u043D\u044F\u0442\u044C</button><button onclick="respondFriend(\'${e.actor}\',false)">\u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C</button></div>`:""}</div>`}async function openNotifications(){closeModal(),++loadGeneration,loading=!1,view="notifications",rememberRoute("notifications"),actions(),main.innerHTML=viewbar("\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F")+\'<div id="notice-list" class="notice-list"></div><div id="notice-next" class="page-sentinel"></div>\',notificationsNext=null,await loadNotifications(!0),scrollMain(0,0)}async function loadNotifications(e=!1){if(!busy.has("notifications")){busy.add("notifications");try{const t=await api("/reef-api/notifications"+(!e&&notificationsNext?"?before="+notificationsNext:""));if(view!=="notifications")return;notificationsNext=t.next;const n=document.getElementById("notice-list");e&&(n.innerHTML=""),n.insertAdjacentHTML("beforeend",t.notifications.map(notificationHTML).join("")),e&&!t.notifications.length&&(n.innerHTML=\'<div class="empty">\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439</div>\'),document.getElementById("notice-next").innerHTML=t.next?\'<button onclick="loadNotifications()">\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0435\u0449\u0451</button>\':"",t.notifications.length&&await api("/reef-api/notifications/read",{method:"POST",body:JSON.stringify({ids:t.notifications.map(a=>a.id)})}),await checkUpdates()}catch(t){toast(t.message)}finally{busy.delete("notifications")}}}function openNotice(e,t,n){e==="message"?openChat(t,!0):n?openPost(n):openProfile(t)}function sendChunk(e,t,n){return new Promise((a,o)=>{const i=new XMLHttpRequest;i.open("PUT",e),i.responseType="json",i.withCredentials=!0,i.upload.onprogress=s=>{s.lengthComputable&&n?.(s.loaded)},i.onload=()=>i.status>=200&&i.status<300?a(i.response):o(Error(i.response?.error||"\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0447\u0430\u0441\u0442\u044C \u0432\u0438\u0434\u0435\u043E")),i.onerror=()=>o(Error("\u0421\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u043F\u0440\u0435\u0440\u0432\u0430\u043D\u043E")),i.send(t)})}async function uploadVideoParts(e,t){const n=["video/mp4","video/webm","video/quicktime"].includes(e.file.type)?e.file.type:"video/mp4",a=await api("/reef-api/uploads",{method:"POST",body:JSON.stringify({size:e.file.size,type:n,width:e.width,height:e.height})}),o=e.file.size;for(let s=0,r=1;s<o;s+=a.partSize,r++){const l=e.file.slice(s,Math.min(o,s+a.partSize));let c=!1,u;for(let m=0;m<3&&!c;m++)try{await sendChunk("/reef-api/uploads/"+a.id+"/part?number="+r,l,p=>t?.(Math.min(99,Math.round((s+p)/o*100)))),c=!0}catch(p){u=p}if(!c)throw u}const i=await api("/reef-api/uploads/"+a.id+"/complete",{method:"POST",body:"{}"});if(e.thumbnail)try{const s=await api("/reef-api/media/"+i.id+"/thumbnail",{method:"PUT",headers:{"content-type":e.thumbnail.type},body:e.thumbnail});i.thumbnail=s.url}catch{toast("\u0412\u0438\u0434\u0435\u043E \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0431\u0435\u0437 \u043F\u0440\u0435\u0432\u044C\u044E")}return t?.(100),i}async function openAdmin(){["owner","admin"].includes(me.role)&&(closeModal(),++loadGeneration,loading=!1,view="admin",rememberRoute("admin"),actions(),adminQuery="",main.innerHTML=viewbar("\u0410\u0434\u043C\u0438\u043D-\u043F\u0430\u043D\u0435\u043B\u044C")+\'<div class="admin-stats" id="admin-stats"></div><form class="admin-search" onsubmit="event.preventDefault();adminQuery=this.query.value;loadAdmin(true)"><input name="query" placeholder="\u0418\u043C\u044F \u0438\u043B\u0438 \u043F\u043E\u0447\u0442\u0430" aria-label="\u041D\u0430\u0439\u0442\u0438 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F"><button>\u041D\u0430\u0439\u0442\u0438</button></form><div id="admin-users"></div><div id="admin-next" class="page-sentinel"></div>\',await loadAdmin(!0),scrollMain(0,0))}function adminUserHTML(e){const t=["owner","admin"].includes(e.role);return`<section class="admin-user"><strong>${esc(e.name)}</strong>${t?" "+badge():""}<p>${esc(e.email)}</p><p>\u041F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F: ${e.used} / ${t?"\u0431\u0435\u0437 \u043B\u0438\u043C\u0438\u0442\u0430":e.invite_limit}</p><div class="admin-user-actions">${t?"":`<button onclick="adminGrant(\'${e.id}\')">+3 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F</button>`}<button onclick="adminMakeInvite(\'${e.id}\')">\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0441\u0441\u044B\u043B\u043A\u0443</button><button onclick="manageCustomBadges(\'${e.id}\')">\u0417\u043D\u0430\u0447\u043A\u0438</button><button onclick="editFeedMode(\'${e.id}\',\'${e.feed_mode||"normal"}\')">\u041B\u0435\u043D\u0442\u0430: ${e.feed_mode==="screen"?"\u043D\u0430 \u0432\u0435\u0441\u044C \u044D\u043A\u0440\u0430\u043D":"\u043E\u0431\u044B\u0447\u043D\u0430\u044F"}</button>${e.id!==me.id?`<button onclick="adminEndSessions(\'${e.id}\')">\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0441\u0435\u0430\u043D\u0441\u044B</button>`:""}</div></section>`}async function loadAdmin(e=!1){if(!busy.has("admin")){busy.add("admin");try{const t=await api("/reef-api/admin?q="+encodeURIComponent(adminQuery)+(!e&&adminNext?"&after="+encodeURIComponent(adminNext):""));if(view!=="admin")return;adminNext=t.next,document.getElementById("admin-stats").innerHTML=[["\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432",t.stats.members],["\u041F\u043E\u0441\u0442\u043E\u0432",t.stats.posts],["\u041C\u0411 \u0444\u0430\u0439\u043B\u043E\u0432",Math.round(t.stats.bytes/1024/1024)]].map(([a,o])=>`<div class="admin-stat"><strong>${o}</strong><small>${a}</small></div>`).join("");const n=document.getElementById("admin-users");e&&(n.innerHTML=""),n.insertAdjacentHTML("beforeend",t.users.map(adminUserHTML).join("")),document.getElementById("admin-next").innerHTML=t.next?\'<button onclick="loadAdmin()">\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0435\u0449\u0451</button>\':""}catch(t){toast(t.message)}finally{busy.delete("admin")}}}async function adminGrant(e){try{await api("/reef-api/admin/members/"+e+"/quota",{method:"POST",body:\'{"add":3}\'}),await loadAdmin(!0),toast("\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E 3 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F")}catch(t){toast(t.message)}}async function adminMakeInvite(e){try{const t=await api("/reef-api/admin/members/"+e+"/invite",{method:"POST",body:"{}"});inviteLink=t.url,inviteCode=t.code||"",inviteExpiry=t.expires,modal("\u041F\u0440\u0438\u0433\u043B\u0430\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430",`<p>\u0421\u0441\u044B\u043B\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u043D\u0430 \u043E\u0442 \u0438\u043C\u0435\u043D\u0438 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u043E\u0433\u043E \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F. \u041F\u043E\u0441\u043B\u0435 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438 \u043D\u043E\u0432\u044B\u0439 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u043F\u043E\u043B\u0443\u0447\u0438\u0442 \u0437\u0430\u044F\u0432\u043A\u0443 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F \u043E\u0442 \u043D\u0435\u0433\u043E.</p><input id="invite-link" class="invite-link" value="${esc(t.url)}" readonly onclick="this.select()"><button class="primary" onclick="copyInvite(this)" data-copy-invite>\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0441\u044B\u043B\u043A\u0443</button>`),await loadAdmin(!0)}catch(t){toast(t.message)}}function adminEndSessions(e){modal("\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0441\u0435\u0430\u043D\u0441\u044B?",`<p>\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044E \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0441\u043D\u043E\u0432\u0430 \u0432\u043E\u0439\u0442\u0438 \u0441 \u043F\u043E\u0447\u0442\u043E\u0439 \u0438 \u043F\u0430\u0440\u043E\u043B\u0435\u043C. \u0415\u0433\u043E \u0434\u0430\u043D\u043D\u044B\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0442\u0441\u044F.</p><button class="primary" onclick="confirmEndSessions(\'${e}\')">\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0441\u0435\u0430\u043D\u0441\u044B</button>`)}async function confirmEndSessions(e){try{await api("/reef-api/admin/members/"+e+"/sessions",{method:"POST",body:"{}"}),closeModal(),toast("\u0421\u0435\u0430\u043D\u0441\u044B \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u044B")}catch(t){toast(t.message)}}function rememberRoute(e,t=""){const n=e==="feed"?"":e==="profile"||e==="chat"||e==="friends"?"#"+e+"="+encodeURIComponent(t):"#"+e;history.replaceState(null,"",location.pathname+n)}async function restoreRoute(){const e=new URLSearchParams(location.hash.slice(1));e.get("profile")?(await openProfile(e.get("profile")),view!=="profile"&&await loadFeed(!0)):e.get("chat")?await openChat(e.get("chat"),!0):e.has("inbox")?await openInbox():e.has("notifications")?await openNotifications():e.has("requests")?await openFriendRequests():e.get("friends")?await openFriendsList(e.get("friends")):e.has("admin")&&["owner","admin"].includes(me.role)?await openAdmin():(view="feed",rememberRoute("feed"),actions(),await loadFeed(!0))}function openAvatar(){profile?.avatar&&(lastFocus=document.activeElement,lightboxPost=null,document.getElementById("lightboxroot").innerHTML=`<div class="lightbox avatar-lightbox" role="dialog" aria-modal="true" aria-label="\u0410\u0432\u0430\u0442\u0430\u0440\u043A\u0430 ${esc(profile.name)}" onclick="if(event.target===this)closePhoto()"><button class="close-photo" onclick="closePhoto()" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C">\xD7</button><img src="${esc(profile.avatar.split("?")[0])}" alt="\u0410\u0432\u0430\u0442\u0430\u0440\u043A\u0430 ${esc(profile.name)}"></div>`,document.body.style.overflow="hidden",document.querySelector(".close-photo").focus())}function doubleLike(e,t){if(e.target.closest("button,input,textarea,select,video,a"))return;clearTimeout(photoTapTimer),suppressPhotoUntil=Date.now()+450,like(t,!0);const n=e.target.closest("[data-post-id]");if(!n||n.querySelector(".double-like-heart"))return;const a=document.createElement("span");a.className="double-like-heart",a.innerHTML=svg("heart"),n.append(a),setTimeout(()=>a.remove(),700)}let postTouch=null,lastPostTap=null;document.addEventListener("pointerdown",e=>{if(e.pointerType!=="touch"||e.target.closest("button,input,textarea,select,video,a")){postTouch=null;return}const t=e.target.closest("[data-post-id]");postTouch=t?{id:t.dataset.postId,x:e.clientX,y:e.clientY,time:Date.now()}:null},{passive:!0}),document.addEventListener("pointerup",e=>{const t=postTouch;if(postTouch=null,!t||e.pointerType!=="touch"||Math.hypot(e.clientX-t.x,e.clientY-t.y)>16||Date.now()-t.time>400)return;const n=Date.now();lastPostTap&&lastPostTap.id===t.id&&n-lastPostTap.time<330&&Math.hypot(e.clientX-lastPostTap.x,e.clientY-lastPostTap.y)<25?(doubleLike(e,t.id),lastPostTap=null):lastPostTap={id:t.id,x:e.clientX,y:e.clientY,time:n}},{passive:!0}),document.addEventListener("pointercancel",()=>{postTouch=null,lastPostTap=null},{passive:!0});function friendControls(e){return e.friend?`<button class="remove-friend-button" onclick="confirmRemoveFriend(\'${e.id}\')">${svg("users")}\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0438\u0437 \u0434\u0440\u0443\u0437\u0435\u0439</button>`:e.request==="incoming"?`<button class="accept-friend" onclick="respondFriend(\'${e.id}\',true)">${svg("check")}\u041F\u0440\u0438\u043D\u044F\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0443</button><button onclick="respondFriend(\'${e.id}\',false)">\u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C</button>`:e.request==="outgoing"?`<button onclick="cancelFriendRequest(\'${e.id}\')">\u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0443</button>`:`<button onclick="addFriend(\'${e.id}\')">${svg("userPlus")}\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0432 \u0434\u0440\u0443\u0437\u044C\u044F</button>`}async function refreshFriendScreen(e){view==="profile"?await openProfile(e):view==="requests"?await openFriendRequests():view==="notifications"&&await openNotifications(),await checkUpdates()}async function respondFriend(e,t){const n="friend:"+e;if(!busy.has(n)){busy.add(n);try{const a=await api("/reef-api/friend-requests/"+e+"/"+(t?"accept":"decline"),{method:"POST",body:"{}"});t&&(feedReady=!1,state.posts=[],rememberFriend("friend:"+me.id+":"+e+":"+e),a.friend&&celebrateFriend(a.friend)),closeModal(),await refreshFriendScreen(e),toast(t?"\u0417\u0430\u044F\u0432\u043A\u0430 \u043F\u0440\u0438\u043D\u044F\u0442\u0430. \u0422\u0435\u043F\u0435\u0440\u044C \u0432\u044B \u0434\u0440\u0443\u0437\u044C\u044F.":"\u0417\u0430\u044F\u0432\u043A\u0430 \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0430")}catch(a){toast(a.message)}finally{busy.delete(n)}}}async function cancelFriendRequest(e){try{await api("/reef-api/friend-requests/"+e,{method:"DELETE"}),await refreshFriendScreen(e),toast("\u0417\u0430\u044F\u0432\u043A\u0430 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430")}catch(t){toast(t.message)}}function confirmRemoveFriend(e){modal("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0438\u0437 \u0434\u0440\u0443\u0437\u0435\u0439?",`<p>\u0414\u043B\u044F \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F \u0434\u0440\u0443\u0436\u0431\u044B \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u043D\u043E\u0432\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430 \u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435.</p><button class="primary" onclick="removeFriend(\'${e}\')">\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0438\u0437 \u0434\u0440\u0443\u0437\u0435\u0439</button><button class="auth-switch" style="width:100%" onclick="closeModal()">\u041E\u0442\u043C\u0435\u043D\u0430</button>`)}async function removeFriend(e){const t="friend:"+e;if(!busy.has(t)){busy.add(t);try{await api("/reef-api/friends/"+e,{method:"DELETE"}),feedReady=!1,state.posts=[],closeModal(),await refreshFriendScreen(e),toast("\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u0443\u0434\u0430\u043B\u0451\u043D \u0438\u0437 \u0434\u0440\u0443\u0437\u0435\u0439")}catch(n){toast(n.message)}finally{busy.delete(t)}}}function requestRow(e,t){return`<div class="request-row"><button class="request-person" onclick="openProfile(\'${e.id}\')">${avatar(e)}<strong>${esc(e.name)}</strong></button><div class="friend-request-actions">${t?`<button class="accept-friend" onclick="respondFriend(\'${e.id}\',true)">\u041F\u0440\u0438\u043D\u044F\u0442\u044C</button><button onclick="respondFriend(\'${e.id}\',false)">\u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C</button>`:`<button onclick="cancelFriendRequest(\'${e.id}\')">\u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0443</button>`}</div></div>`}async function openFriendRequests(){closeModal(),++loadGeneration,loading=!1,view="requests",rememberRoute("requests"),actions();try{const e=await api("/reef-api/friend-requests");if(view!=="requests")return;main.innerHTML=viewbar("\u0417\u0430\u044F\u0432\u043A\u0438 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F")+`<section class="request-section"><h2>\u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435</h2>${e.incoming.map(t=>requestRow(t,!0)).join("")||\'<p class="request-empty">\u041D\u043E\u0432\u044B\u0445 \u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442</p>\'}<h2>\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435</h2>${e.outgoing.map(t=>requestRow(t,!1)).join("")||\'<p class="request-empty">\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0445 \u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442</p>\'}</section>`,scrollMain(0,0)}catch(e){toast(e.message)}}navigator.serviceWorker?.addEventListener?.("message",e=>{e.data?.type==="reef-push"&&me&&(checkUpdates().catch(()=>{}),syncLivePosts().catch(()=>{}))});function verifiedBadge(){return`<span class="telegram-badge" title="Telegram \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D" aria-label="Telegram \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D">${svg("check")}</span>`}function staffBadge(e="admin"){const t={owner:"\u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440",admin:"\u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440",moderator:"\u041C\u043E\u0434\u0435\u0440\u0430\u0442\u043E\u0440",support:"\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430"},n=t[e]||"\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A Reef";return`<span class="staff-badge admin-badge" role="button" tabindex="0" onclick="event.stopPropagation();showStaffInfo(\'${e}\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();showStaffInfo(\'${e}\')}" title="${n}" aria-label="${n}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/>${e==="moderator"?\'<path d="M8 12h8M12 8v8"/>\':e==="support"?\'<circle cx="12" cy="10" r="2"/><path d="M8 16a4 4 0 0 1 8 0"/>\':\'<path d="m8 10 4-3 4 3-2 6h-4z"/>\'}</svg></span>`}function showStaffInfo(e){modal({owner:"\u0410\u0434\u043C\u0438\u043D-\u0430\u043A\u043A\u0430\u0443\u043D\u0442",admin:"\u0410\u0434\u043C\u0438\u043D-\u0430\u043A\u043A\u0430\u0443\u043D\u0442",moderator:"\u041C\u043E\u0434\u0435\u0440\u0430\u0442\u043E\u0440 Reef",support:"\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430 Reef"}[e]||"\u041A\u043E\u043C\u0430\u043D\u0434\u0430 Reef",`<p>${e==="owner"||e==="admin"?"\u042D\u0442\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 Reef. \u041E\u043D \u0443\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u0441\u0435\u0442\u044C\u044E \u0438 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F\u043C\u0438.":"\u042D\u0442\u043E\u0442 \u0430\u043A\u043A\u0430\u0443\u043D\u0442 \u043F\u0440\u0438\u043D\u0430\u0434\u043B\u0435\u0436\u0438\u0442 \u043A\u043E\u043C\u0430\u043D\u0434\u0435 Reef."}</p><p>\u0417\u043D\u0430\u0447\u043E\u043A \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430 \u043E\u0442\u043B\u0438\u0447\u0430\u0435\u0442\u0441\u044F \u043E\u0442 \u0433\u0430\u043B\u043E\u0447\u043A\u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u043E\u0433\u043E Telegram.</p>`)}function centralAction(){view==="feed"?startPost():backToFeed()}function openAccountMenu(){const e=document.documentElement.dataset.theme==="dark";modal("\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",`<div class="account-menu"><button onclick="openFriendRequests()">${svg("userPlus")}<span>\u0417\u0430\u044F\u0432\u043A\u0438 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F</span>${requestsUnread?`<small>${requestsUnread}</small>`:""}</button><button onclick="toggleTheme()">${svg(e?"sun":"moon")}<span>${e?"\u0421\u0432\u0435\u0442\u043B\u0430\u044F \u0442\u0435\u043C\u0430":"\u0422\u0451\u043C\u043D\u0430\u044F \u0442\u0435\u043C\u0430"}</span></button><button onclick="showPushSettings()">${svg("bell")}<span>\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435</span></button>${["owner","admin"].includes(me.role)?`<button onclick="openAdmin()">${svg("settings")}<span>\u0410\u0434\u043C\u0438\u043D-\u043F\u0430\u043D\u0435\u043B\u044C</span></button>`:""}<label class="invisible-setting"><span>${svg("eye")}\u0420\u0435\u0436\u0438\u043C \u043D\u0435\u0432\u0438\u0434\u0438\u043C\u043A\u0438<small>\u0421\u043A\u0440\u044B\u0432\u0430\u0435\u0442 \u0441\u0442\u0430\u0442\u0443\u0441 \u0438 \u0432\u0440\u0435\u043C\u044F \u043F\u043E\u0441\u0435\u0449\u0435\u043D\u0438\u044F</small></span><input type="checkbox" role="switch" ${me.invisible?"checked":""} onchange="saveInvisible(this)"></label><button onclick="logout()">${svg("back")}<span>\u0412\u044B\u0439\u0442\u0438</span></button></div>`)}async function syncLivePosts(){if(!me||busy.has("live"))return;const e=[...document.querySelectorAll("[data-post-id]")].filter(a=>{if(typeof a.getBoundingClientRect!="function")return!0;const o=a.getBoundingClientRect();return o.bottom>=-100&&o.top<=(window.innerHeight||900)+100}),t=[...new Set(e.map(a=>a.dataset.postId))].slice(0,12);if(!t.length)return;const n=new Map(t.map(a=>[a,findPost(a)?._liveVersion||0]));busy.add("live");try{const a=await api("/reef-api/live",{method:"POST",body:JSON.stringify({posts:t,comments:t.filter(o=>openComments.has(o)).slice(0,4)})});for(const o of a.posts){const i=findPost(o.id);if(!i||busy.has(i.id)||n.get(i.id)!==(i._liveVersion||0))continue;const s=i.canComment!==o.canComment,r=JSON.stringify(i.poll)!==JSON.stringify(o.poll),l=JSON.stringify(i.tags)!==JSON.stringify(o.tags);if(Object.assign(i,o),s&&openComments.has(i.id)&&refreshCommentDraft(i.id),r&&updatePoll(i),l&&updatePhotoTags(i),document.querySelectorAll(`[data-post-id="${i.id}"] .posthead .avatar`).forEach(c=>setAvatarOnline(c,i.online)),document.querySelectorAll(`[data-like="${i.id}"]`).forEach(c=>{c.classList.toggle("liked",i.liked),c.setAttribute("aria-pressed",i.liked),c.querySelector("span").textContent=i.likes,document.querySelectorAll(`[data-like-count="${i.id}"]`).forEach(u=>u.textContent=i.likes||"")}),document.querySelectorAll(`[data-comments="${i.id}"] span`).forEach(c=>c.textContent=i.commentCount||""),a.comments[i.id]&&!busy.has("comment:"+i.id)){const c=commentCache.get(i.id)||[],u=a.comments[i.id];if(JSON.stringify(c)!==JSON.stringify(u)){commentCache.set(i.id,u);const m=htmlNode(commentsHTML(i.id)),p=m.querySelector(".comments-items");document.querySelectorAll(`[data-post-id="${i.id}"] .comments-items`).forEach(f=>f.innerHTML=p.innerHTML)}}}for(const o of a.unavailable)state.posts=state.posts.filter(i=>i.id!==o),document.querySelectorAll(`[data-post-id="${o}"]`).forEach(i=>i.remove())}finally{busy.delete("live")}}let topNoticeBaseline=null,topNoticeQueue=[],topNoticeBusy=!1;function handleTopNotices(e){if(!me)return;const t="reef-top-events-"+me.id;let n=topNoticeBaseline;if(!n){try{const o=localStorage.getItem(t);n=o?new Set(JSON.parse(o)):null}catch{}if(!n){topNoticeBaseline=new Set(e.map(o=>o.id));try{localStorage.setItem(t,JSON.stringify([...topNoticeBaseline]))}catch{}return}topNoticeBaseline=n}const a=e.filter(o=>!n.has(o.id));for(const o of e)n.add(o.id);topNoticeBaseline=new Set([...n].slice(-100));try{localStorage.setItem(t,JSON.stringify([...topNoticeBaseline]))}catch{}for(const o of a.slice(0,3).reverse())o.kind!=="friend"&&topNoticeQueue.push(o);displayTopNotice()}function displayTopNotice(){if(topNoticeBusy||!topNoticeQueue.length||!me)return;topNoticeBusy=!0;const e=topNoticeQueue.shift(),t=document.createElement("div");t.className="top-notice",t.setAttribute("role","status"),t.innerHTML=`<button class="top-notice-open" onclick="openNotice(\'${e.kind}\',\'${esc(e.actor)}\',\'${esc(e.post||"")}\');this.closest(\'.top-notice\').remove()">${avatar(e)}<span><strong>${esc(e.name)}</strong><small>${notificationText[e.kind]||"\u041D\u043E\u0432\u043E\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435"}</small></span></button><button class="top-notice-close" onclick="this.closest(\'.top-notice\').remove()" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C">\xD7</button>`,document.body.append(t),setTimeout(()=>{t.remove(),topNoticeBusy=!1,displayTopNotice()},4800)}function pushBytes(e){return Uint8Array.from(atob(e.replaceAll("-","+").replaceAll("_","/")),t=>t.charCodeAt(0))}async function showPushSettings(){if(!("serviceWorker"in navigator)||!("PushManager"in window)){modal("\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F",`<div class="push-hero"><div class="push-hero-icon">${svg("bell")}</div><h3>\u0411\u0443\u0434\u044C\u0442\u0435 \u0431\u043B\u0438\u0436\u0435 \u043A \u0441\u0432\u043E\u0435\u043C\u0443 \u043A\u0440\u0443\u0433\u0443</h3><p>\u041B\u0430\u0439\u043A\u0438, \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438 \u0438 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u2014 \u043F\u0440\u044F\u043C\u043E \u043D\u0430 \u044D\u043A\u0440\u0430\u043D \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430.</p></div><div class="push-help-card"><strong>\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 Reef \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435</strong><p>\u041D\u0430 iPhone \u0434\u043E\u0431\u0430\u0432\u044C\u0442\u0435 Reef \u043D\u0430 \u044D\u043A\u0440\u0430\u043D \u0414\u043E\u043C\u043E\u0439 \u0447\u0435\u0440\u0435\u0437 Safari \u0438 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u043E \u0437\u043D\u0430\u0447\u043A\u0430. \u041D\u0443\u0436\u043D\u0430 iOS 16.4 \u0438\u043B\u0438 \u043D\u043E\u0432\u0435\u0435.</p><p>\u041D\u0430 Android \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0431\u0440\u0430\u0443\u0437\u0435\u0440 \u0441 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u043E\u0439 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439.</p></div>`,"push-settings-modal");return}try{const e=await pushRegistration(),t=await e.pushManager.getSubscription(),n=typeof Notification<"u"&&Notification.permission==="granted",a=t?await api("/reef-api/push/status",{method:"POST",body:JSON.stringify({endpoint:t.endpoint})}):null,o=t&&n&&a?.registered;let i=o?"Reef \u043C\u043E\u0436\u0435\u0442 \u043F\u0440\u0438\u0441\u044B\u043B\u0430\u0442\u044C \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F, \u043A\u043E\u0433\u0434\u0430 \u0441\u0430\u0439\u0442 \u0437\u0430\u043A\u0440\u044B\u0442.":"\u0412\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u0442\u044C \u043D\u043E\u0432\u043E\u0435.";a?.error?i=a.error+". \u041F\u0435\u0440\u0435\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443.":o&&a.success&&(i="\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043F\u0440\u0438\u043D\u044F\u0442\u043E \u0441\u0435\u0440\u0432\u0438\u0441\u043E\u043C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430."),typeof Notification<"u"&&Notification.permission==="denied"&&(i="\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u0434\u043B\u044F Reef \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430 \u0438 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430."),modal("\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F",`<div class="push-hero"><div class="push-hero-icon">${svg("bell")}</div><span class="push-state ${o?"enabled":""}">${o?"\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u044B":"\u041D\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u044B"}</span><h3>\u0412\u0441\u0451 \u0432\u0430\u0436\u043D\u043E\u0435 \u2014 \u0440\u044F\u0434\u043E\u043C</h3><p class="push-device-status" role="status">${esc(i)}</p></div><div class="push-events"><span>${svg("heart")}\u041B\u0430\u0439\u043A\u0438 \u0438 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438</span><span>${svg("comment")}\u041B\u0438\u0447\u043D\u044B\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F</span><span>${svg("userPlus")}\u0417\u0430\u044F\u0432\u043A\u0438 \u0432 \u0434\u0440\u0443\u0437\u044C\u044F</span></div><button class="primary" onclick="enableDevicePush()">${o?"\u041F\u0435\u0440\u0435\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C":"\u0412\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F"}</button>${t?\'<button class="push-test-button" onclick="testDevicePush()">\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043F\u0440\u043E\u0432\u0435\u0440\u043E\u0447\u043D\u043E\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435</button><button class="push-disable-button" onclick="disableDevicePush()">\u0412\u044B\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043D\u0430 \u044D\u0442\u043E\u043C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435</button>\':""}<details class="push-help-card"><summary>\u0415\u0441\u043B\u0438 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043D\u0435 \u0432\u0438\u0434\u043D\u044B</summary><p>\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430, \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439 \u0438 \u0440\u0435\u0436\u0438\u043C \xAB\u041D\u0435 \u0431\u0435\u0441\u043F\u043E\u043A\u043E\u0438\u0442\u044C\xBB \u043D\u0430 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0435. \u041D\u0430 iPhone \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0439\u0442\u0435 Reef \u0441\u043E \u0437\u043D\u0430\u0447\u043A\u0430 \u043D\u0430 \u044D\u043A\u0440\u0430\u043D\u0435 \u0414\u043E\u043C\u043E\u0439.</p></details>`,"push-settings-modal")}catch(e){toast(e.message)}}async function enableDevicePush(){try{if(await Notification.requestPermission()!=="granted"){toast("\u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E. \u0418\u0437\u043C\u0435\u043D\u0438\u0442\u0435 \u0435\u0433\u043E \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430.");return}const t=await pushRegistration(),n=(await api("/reef-api/push/key")).key;let a=await t.pushManager.getSubscription();const o=a?.endpoint;a&&(await a.unsubscribe(),a=null),a=await t.pushManager.subscribe({userVisibleOnly:!0,applicationServerKey:pushBytes(n)}),await api("/reef-api/push/subscription",{method:"POST",body:JSON.stringify(a.toJSON())}),o&&o!==a.endpoint&&await api("/reef-api/push/subscription",{method:"DELETE",body:JSON.stringify({endpoint:o})}),toast("\u041F\u043E\u0434\u043F\u0438\u0441\u043A\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435"),await showPushSettings()}catch(e){toast(e.message||"\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F")}}async function disconnectPush(e=!1){if("serviceWorker"in navigator)try{const t=await pushRegistration(),n=await t.pushManager.getSubscription();n&&(await api("/reef-api/push/subscription",{method:"DELETE",body:JSON.stringify({endpoint:n.endpoint})}),await n.unsubscribe())}catch(t){if(!e)throw t}}async function disableDevicePush(){try{await disconnectPush(),toast("\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u044B"),await showPushSettings()}catch(e){toast(e.message)}}async function pushRegistration(){return Promise.race([navigator.serviceWorker.ready,new Promise((e,t)=>setTimeout(()=>t(Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F. \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 Reef \u0438 \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0441\u043D\u043E\u0432\u0430.")),8e3))])}async function restoreDevicePush(){if(!me||!("serviceWorker"in navigator)||typeof Notification>"u"||Notification.permission!=="granted")return;const e=me.id,t=await pushRegistration(),n=await t.pushManager.getSubscription();n&&me?.id===e&&await api("/reef-api/push/subscription",{method:"POST",body:JSON.stringify(n.toJSON())})}async function testDevicePush(){if(!busy.has("push-test")){busy.add("push-test");try{const e=await pushRegistration(),t=await e.pushManager.getSubscription();if(!t)throw Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435");await api("/reef-api/push/subscription",{method:"POST",body:JSON.stringify(t.toJSON())}),await api("/reef-api/push/test",{method:"POST",body:JSON.stringify({endpoint:t.endpoint})}),toast("\u0421\u0435\u0440\u0432\u0438\u0441 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 \u043F\u0440\u0438\u043D\u044F\u043B \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435"),await showPushSettings()}catch(e){toast(e.message);const t=document.querySelector(".push-device-status");t&&(t.textContent=e.message)}finally{busy.delete("push-test")}}}const customBadgeSymbols={star:["\u0417\u0432\u0435\u0437\u0434\u0430",\'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>\'],crown:["\u041A\u043E\u0440\u043E\u043D\u0430",\'<path d="m3 6 5 5 4-7 4 7 5-5-2 14H5zM7 17h10"/>\'],diamond:["\u0410\u043B\u043C\u0430\u0437",\'<path d="m3 9 5-6h8l5 6-9 12zM3 9h18M8 3l4 18 4-18"/>\'],flame:["\u041E\u0433\u043E\u043D\u044C",\'<path d="M13 2c2 7-4 6-2 11 2-1 3-3 3-5 7 7 6 13-2 13S2 15 7 9c0 4 1 4 2 5-2-6 4-6 4-12Z"/>\'],heart:["\u0421\u0435\u0440\u0434\u0446\u0435",\'<path d="M20 5c-3-3-7 0-8 2-1-2-5-5-8-2-4 4 0 9 8 15 8-6 12-11 8-15Z"/>\'],bolt:["\u041C\u043E\u043B\u043D\u0438\u044F",\'<path d="m14 2-11 12h8l-1 8L21 9h-8z"/>\'],flower:["\u0426\u0432\u0435\u0442\u043E\u043A",\'<path d="M12 8C5-4 1 8 8 11c-13 0-6 12 1 5-3 13 10 10 5 0 9 9 14-5 2-5 9-5-2-14-4-3Z"/><circle cx="12" cy="12" r="2"/>\'],code:["\u041A\u043E\u0434",\'<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>\']};let customBadgeEditor=null;function customBadgeHTML(e,t=!0){const n=e.kind==="image"&&e.image?`<img src="${esc(e.image)}" alt="" loading="lazy" decoding="async">`:e.kind==="emoji"?`<span>${esc(e.icon)}</span>`:`<svg viewBox="0 0 24 24" aria-hidden="true">${customBadgeSymbols[e.icon]?.[1]||customBadgeSymbols.star[1]}</svg>`;return`<span class="custom-badge" style="--badge-color:${/^#[0-9a-f]{6}$/i.test(e.color||"")?e.color:"#9b7dc3"}" ${t?`role="button" tabindex="0" data-badge="${esc(JSON.stringify(e))}" onclick="event.stopPropagation();showCustomBadge(this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();showCustomBadge(this)}"`:""} title="${esc(e.label)}" aria-label="${esc(e.label)}">${n}</span>`}function customBadgesHTML(e){return(e||[]).map(t=>customBadgeHTML(t)).join("")}function showCustomBadge(e){const t=JSON.parse(e.dataset.badge);modal(esc(t.label),`<div class="badge-info-icon">${customBadgeHTML(t,!1)}</div><p>${esc(t.description||t.label)}</p><p class="invite-note">\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u0438\u0439 \u0437\u043D\u0430\u0447\u043E\u043A, \u0432\u044B\u0434\u0430\u043D\u043D\u044B\u0439 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 Reef.</p>`)}async function manageCustomBadges(e){try{const t=await api("/reef-api/admin/members/"+e+"/badges");customBadgeEditor={uid:e,kind:"symbol",icon:"star",mediaId:null,image:null,color:"#9b7dc3",label:"",description:"",uploading:!1},modal("\u0417\u043D\u0430\u0447\u043A\u0438 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F",`<div class="assigned-badges">${t.badges.map(n=>`<div class="assigned-badge-row">${customBadgeHTML(n,!1)}<span>${esc(n.label)}</span><button onclick="revokeCustomBadge(\'${e}\',\'${n.id}\')" aria-label="\u0421\u043D\u044F\u0442\u044C \u0437\u043D\u0430\u0447\u043E\u043A ${esc(n.label)}">\u0421\u043D\u044F\u0442\u044C</button></div>`).join("")||\'<p class="sub">\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u0438\u0445 \u0437\u043D\u0430\u0447\u043A\u043E\u0432.</p>\'}</div><h3 class="badge-form-title">\u0412\u044B\u0434\u0430\u0442\u044C \u0437\u043D\u0430\u0447\u043E\u043A</h3><label>\u0422\u0438\u043F \u0437\u043D\u0430\u0447\u043A\u0430</label><select id="badge-kind" onchange="setBadgeKind(this.value)"><option value="symbol">\u0418\u043A\u043E\u043D\u043A\u0430</option><option value="emoji">\u042D\u043C\u043E\u0434\u0437\u0438</option><option value="image">\u0421\u0432\u043E\u0451 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435</option></select><div id="badge-picker"></div><label>\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435</label><input class="profile-name-input" maxlength="60" placeholder="\u041D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \u041F\u0435\u0440\u0432\u044B\u0439 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A" oninput="customBadgeEditor.label=this.value;renderBadgePreview()"><label>\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043F\u043E \u043D\u0430\u0436\u0430\u0442\u0438\u044E</label><textarea class="bio-input" maxlength="240" placeholder="\u0417\u0430 \u0447\u0442\u043E \u0432\u044B\u0434\u0430\u043D \u0437\u043D\u0430\u0447\u043E\u043A" oninput="customBadgeEditor.description=this.value"></textarea><label class="badge-color-label">\u0426\u0432\u0435\u0442 <input type="color" value="#9b7dc3" oninput="customBadgeEditor.color=this.value;renderBadgePreview()"></label><div id="badge-preview" class="badge-preview"></div><button class="primary" id="grant-badge-button" onclick="grantCustomBadge()">\u0412\u044B\u0434\u0430\u0442\u044C \u0437\u043D\u0430\u0447\u043E\u043A</button><p class="invite-note">\u0414\u043E 5 \u0437\u043D\u0430\u0447\u043A\u043E\u0432 \u0443 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F. \u0417\u043D\u0430\u0447\u043A\u0438 \u043D\u0435 \u043C\u0435\u043D\u044F\u044E\u0442 \u043F\u0440\u0430\u0432\u0430 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 \u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 Telegram.</p>`),setBadgeKind("symbol")}catch(t){toast(t.message)}}function setBadgeKind(e){customBadgeEditor&&(customBadgeEditor.kind=e,e==="symbol"&&!customBadgeSymbols[customBadgeEditor.icon]&&(customBadgeEditor.icon="star"),e==="emoji"&&(customBadgeEditor.icon="\u{1F30A}"),document.getElementById("badge-picker").innerHTML=e==="symbol"?`<div class="badge-symbols">${Object.entries(customBadgeSymbols).map(([t,[n,a]])=>`<button onclick="customBadgeEditor.icon=\'${t}\';selectBadgeSymbol(this);renderBadgePreview()" class="${t===customBadgeEditor.icon?"selected":""}" aria-label="${n}"><svg viewBox="0 0 24 24">${a}</svg></button>`).join("")}</div>`:e==="emoji"?\'<label>\u042D\u043C\u043E\u0434\u0437\u0438</label><input class="profile-name-input" value="\u{1F30A}" maxlength="24" oninput="customBadgeEditor.icon=this.value;renderBadgePreview()" aria-label="\u042D\u043C\u043E\u0434\u0437\u0438 \u0437\u043D\u0430\u0447\u043A\u0430">\':\'<label>\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 PNG, JPEG \u0438\u043B\u0438 WebP</label><input type="file" accept="image/png,image/jpeg,image/webp" onchange="uploadBadgeImage(this.files[0])" aria-label="\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0437\u043D\u0430\u0447\u043A\u0430">\',renderBadgePreview())}function selectBadgeSymbol(e){document.querySelectorAll(".badge-symbols button").forEach(t=>t.classList.remove("selected")),e.classList.add("selected")}function renderBadgePreview(){const e=customBadgeEditor,t=document.getElementById("badge-preview");t&&(t.innerHTML=customBadgeHTML({...e,label:e.label||"\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0437\u043D\u0430\u0447\u043A\u0430"},!1)+`<span>${esc(e.label||"\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0437\u043D\u0430\u0447\u043A\u0430")}</span>`)}async function uploadBadgeImage(e){if(!e||!customBadgeEditor||customBadgeEditor.uploading)return;const t=customBadgeEditor;t.uploading=!0;const n=document.getElementById("grant-badge-button");n.disabled=!0;try{const a=await uploadPrepared(await prepareImage(e,!0));if(customBadgeEditor!==t)return;t.mediaId=a.id,t.image=a.thumbnail||a.url,renderBadgePreview(),toast("\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E")}catch(a){toast(a.message)}finally{t.uploading=!1,n.isConnected&&(n.disabled=!1)}}async function grantCustomBadge(){const e=customBadgeEditor;if(!e||e.uploading||busy.has("badge-grant"))return;busy.add("badge-grant");const t=document.getElementById("grant-badge-button");t.disabled=!0;try{await api("/reef-api/admin/members/"+e.uid+"/badges",{method:"POST",body:JSON.stringify({kind:e.kind,icon:e.icon,mediaId:e.mediaId,label:e.label,description:e.description,color:e.color})}),feedReady=!1,state.posts=[],await manageCustomBadges(e.uid),toast("\u0417\u043D\u0430\u0447\u043E\u043A \u0432\u044B\u0434\u0430\u043D")}catch(n){toast(n.message),t.isConnected&&(t.disabled=!1)}finally{busy.delete("badge-grant")}}async function revokeCustomBadge(e,t){try{await api("/reef-api/admin/members/"+e+"/badges/"+t,{method:"DELETE"}),feedReady=!1,state.posts=[],await manageCustomBadges(e),toast("\u0417\u043D\u0430\u0447\u043E\u043A \u0441\u043D\u044F\u0442")}catch(n){toast(n.message)}}function isScreenFeed(){return view==="feed"&&me?.feedMode==="screen"}function applyFeedMode(){document.documentElement.classList.toggle("screen-feed",isScreenFeed())}function friendWord(e){return e%10===1&&e%100!==11?"\u0434\u0440\u0443\u0433":e%10>=2&&e%10<=4&&(e%100<12||e%100>14)?"\u0434\u0440\u0443\u0433\u0430":"\u0434\u0440\u0443\u0437\u0435\u0439"}let friendsListId=null,friendsListNext=null;async function openFriendsList(e){closeModal(),++loadGeneration,loading=!1,view="friends",friendsListId=e,friendsListNext=null,rememberRoute("friends",e),actions(),main.innerHTML=viewbar(e===me.id?"\u041C\u043E\u0438 \u0434\u0440\u0443\u0437\u044C\u044F":"\u0414\u0440\u0443\u0437\u044C\u044F")+\'<div id="friends-list"></div><div id="friends-next" class="page-sentinel"></div>\',await loadFriendsList(!0),scrollMain(0,0)}async function loadFriendsList(e=!1){if(!busy.has("friends-list")){busy.add("friends-list");try{const t=await api("/reef-api/profiles/"+friendsListId+"/friends"+(!e&&friendsListNext?"?after="+encodeURIComponent(friendsListNext):""));if(view!=="friends")return;friendsListNext=t.next;const n=document.getElementById("friends-list");e&&(n.innerHTML=""),n.insertAdjacentHTML("beforeend",t.friends.map(a=>`<button class="friend-list-row" onclick="openProfile(\'${a.id}\')">${avatar(a)}<span><strong>${esc(a.name)}</strong><small>${presenceLabel(a)}</small></span>${svg("chevron")}</button>`).join("")),e&&!t.friends.length&&(n.innerHTML=\'<div class="empty">\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0440\u0443\u0437\u0435\u0439</div>\'),document.getElementById("friends-next").innerHTML=t.next?\'<button onclick="loadFriendsList()">\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0435\u0449\u0451</button>\':""}catch(t){toast(t.message)}finally{busy.delete("friends-list")}}}async function updatePresence(e){!me||e&&document.visibilityState==="hidden"||(await api(e?"/reef-api/presence":"/reef-api/presence/offline",{method:"POST",body:"{}"}),me.online=e&&!me.invisible,view==="profile"&&profile?.own&&setProfilePresence(e))}function markOffline(){if(me)try{navigator.sendBeacon?.("/reef-api/presence/offline","")}catch{}}function setProfilePresence(e,t=void 0){profile&&(profile.online=e&&!(profile.own&&me?.invisible),t!==void 0&&(profile.lastSeen=t));const n=document.getElementById("profile-presence-text");n&&(n.textContent=presenceLabel(profile||{})),document.querySelector(".profile-presence .presence-dot")?.classList.toggle("online",e&&!(profile?.own&&me?.invisible));const a=document.querySelector(".profile-hero .profile-avatar");a&&setAvatarOnline(a,e&&!(profile?.own&&me?.invisible))}async function refreshProfilePresence(){if(view!=="profile"||!profile)return;const e=profile.id,t=await api("/reef-api/profiles/"+e+"/presence");view==="profile"&&profile.id===e&&setProfilePresence(t.online,t.lastSeen)}function editFeedMode(e,t){modal("\u0412\u0438\u0434 \u043B\u0435\u043D\u0442\u044B",`<p>\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0438\u0434 \u043B\u0435\u043D\u0442\u044B \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F.</p><button class="feed-mode-option ${t==="normal"?"selected":""}" onclick="setUserFeedMode(\'${e}\',\'normal\')"><strong>\u041E\u0431\u044B\u0447\u043D\u0430\u044F \u043B\u0435\u043D\u0442\u0430</strong><span>\u041F\u043E\u0441\u0442\u044B \u0434\u0440\u0443\u0433 \u0437\u0430 \u0434\u0440\u0443\u0433\u043E\u043C, \u0441\u0432\u043E\u0431\u043E\u0434\u043D\u0430\u044F \u043F\u0440\u043E\u043A\u0440\u0443\u0442\u043A\u0430.</span></button><button class="feed-mode-option ${t==="screen"?"selected":""}" onclick="setUserFeedMode(\'${e}\',\'screen\')"><strong>\u041E\u0434\u0438\u043D \u043F\u043E\u0441\u0442 \u043D\u0430 \u044D\u043A\u0440\u0430\u043D</strong><span>\u0421\u0432\u0430\u0439\u043F \u0432\u0432\u0435\u0440\u0445 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0435\u0442 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E. \u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u044E\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0439 \u043F\u0430\u043D\u0435\u043B\u044C\u044E.</span></button>`)}async function setUserFeedMode(e,t){try{await api("/reef-api/admin/members/"+e+"/feed-mode",{method:"POST",body:JSON.stringify({mode:t})}),e===me.id&&(me.feedMode=t),closeModal(),await loadAdmin(!0),toast(t==="screen"?"\u041F\u043E\u043B\u043D\u043E\u044D\u043A\u0440\u0430\u043D\u043D\u0430\u044F \u043B\u0435\u043D\u0442\u0430 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u0430 \u0434\u043B\u044F \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F":"\u041E\u0431\u044B\u0447\u043D\u0430\u044F \u043B\u0435\u043D\u0442\u0430 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u0430 \u0434\u043B\u044F \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F")}catch(n){toast(n.message)}}let photoTapTimer=null,suppressPhotoUntil=0;function photoTap(e,t,n){Date.now()<suppressPhotoUntil||(clearTimeout(photoTapTimer),photoTapTimer=setTimeout(()=>openPhoto(t,n),350))}let photoZoom={scale:1,x:0,y:0,pointers:new Map,pinch:0,pinchScale:1,start:null,hadPinch:!1};function paintLightbox(){const e=lightboxPost.media[lightboxIndex];photoZoom={scale:1,x:0,y:0,pointers:new Map,pinch:0,pinchScale:1,start:null,hadPinch:!1},document.getElementById("lightboxroot").innerHTML=`<div class="lightbox photo-lightbox" role="dialog" aria-modal="true" aria-label="\u0424\u043E\u0442\u043E \u043A\u0440\u0443\u043F\u043D\u0435\u0435"><button class="close-photo" onclick="closePhoto()" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C">\xD7</button><div class="photo-zoom-viewport">${e.type.startsWith("video/")?`<video src="${esc(e.url)}" controls playsinline></video>`:`<img class="zoom-image" src="${esc(e.url)}" alt="\u0424\u043E\u0442\u043E ${lightboxIndex+1}" draggable="false">`}</div>${lightboxPost.media.length>1?`<button class="lightbox-nav lightbox-prev" onclick="stepPhoto(-1)" aria-label="\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0435">\u2039</button><button class="lightbox-nav" onclick="stepPhoto(1)" aria-label="\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0435">\u203A</button><span class="lightbox-count">${lightboxIndex+1} / ${lightboxPost.media.length}</span>`:""}${e.type.startsWith("video/")?"":\'<div class="photo-zoom-controls"><button onclick="changePhotoZoom(-.5)" aria-label="\u0423\u043C\u0435\u043D\u044C\u0448\u0438\u0442\u044C">\u2212</button><button onclick="resetPhotoZoom()" id="photo-zoom-level">100%</button><button onclick="changePhotoZoom(.5)" aria-label="\u0423\u0432\u0435\u043B\u0438\u0447\u0438\u0442\u044C">+</button></div>\'}</div>`,document.body.style.overflow="hidden";const t=document.querySelector(".photo-zoom-viewport");t.addEventListener("pointerdown",zoomPointerDown),t.addEventListener("pointermove",zoomPointerMove),t.addEventListener("pointerup",zoomPointerUp),t.addEventListener("pointercancel",zoomPointerUp),t.addEventListener("wheel",n=>{e.type.startsWith("video/")||(n.preventDefault(),changePhotoZoom(n.deltaY<0?.2:-.2))},{passive:!1}),document.querySelector(".close-photo").focus()}function renderPhotoZoom(){const e=document.querySelector(".zoom-image");e&&(e.style.transform=`translate(${photoZoom.x}px,${photoZoom.y}px) scale(${photoZoom.scale})`);const t=document.getElementById("photo-zoom-level");t&&(t.textContent=Math.round(photoZoom.scale*100)+"%")}function changePhotoZoom(e){photoZoom.scale=Math.min(5,Math.max(1,photoZoom.scale+e)),photoZoom.scale===1&&(photoZoom.x=0,photoZoom.y=0),renderPhotoZoom()}function resetPhotoZoom(){photoZoom.scale=1,photoZoom.x=0,photoZoom.y=0,renderPhotoZoom()}function zoomPointerDown(e){if(!e.target.closest("video")&&(photoZoom.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}),e.currentTarget.setPointerCapture?.(e.pointerId),photoZoom.pointers.size===1&&(photoZoom.start={x:e.clientX,y:e.clientY},photoZoom.hadPinch=!1),photoZoom.pointers.size===2)){const[t,n]=[...photoZoom.pointers.values()];photoZoom.pinch=Math.hypot(t.x-n.x,t.y-n.y),photoZoom.pinchScale=photoZoom.scale,photoZoom.hadPinch=!0}}function zoomPointerMove(e){const t=photoZoom.pointers.get(e.pointerId);if(t){if(photoZoom.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}),photoZoom.pointers.size===2){const[n,a]=[...photoZoom.pointers.values()];photoZoom.scale=Math.min(5,Math.max(1,photoZoom.pinchScale*Math.hypot(n.x-a.x,n.y-a.y)/Math.max(1,photoZoom.pinch))),photoZoom.scale===1&&(photoZoom.x=0,photoZoom.y=0)}else if(photoZoom.scale>1){const n=e.currentTarget.getBoundingClientRect(),a=n.width*(photoZoom.scale-1)/2,o=n.height*(photoZoom.scale-1)/2;photoZoom.x=Math.max(-a,Math.min(a,photoZoom.x+e.clientX-t.x)),photoZoom.y=Math.max(-o,Math.min(o,photoZoom.y+e.clientY-t.y))}renderPhotoZoom()}}function zoomPointerUp(e){const t=photoZoom.start;photoZoom.pointers.delete(e.pointerId),!photoZoom.pointers.size&&t&&!photoZoom.hadPinch&&photoZoom.scale===1&&Math.abs(e.clientX-t.x)>70&&Math.abs(e.clientX-t.x)>Math.abs(e.clientY-t.y)&&lightboxPost.media.length>1&&stepPhoto(e.clientX<t.x?1:-1)}function bindSheetDrag(){const e=document.querySelector(".modal"),t=e?.querySelector(".sheet-handle");if(!t)return;let n=null,a=0;t.addEventListener("pointerdown",i=>{i.button!==void 0&&i.button!==0||(n=i.clientY,a=0,t.setPointerCapture?.(i.pointerId),e.classList.add("sheet-dragging"))}),t.addEventListener("pointermove",i=>{n!==null&&(a=Math.max(0,i.clientY-n),e.style.transform=`translateY(${a}px)`)});const o=i=>{n!==null&&(n=null,e.classList.remove("sheet-dragging"),i.type!=="pointercancel"&&a>70?closeModal():e.style.transform="",a=0)};t.addEventListener("pointerup",o),t.addEventListener("pointercancel",o)}function postParagraphs(e){return String(e).replace(/\\r\\n?/g,`\n`).split(/\\n[ \\t]*\\n+/).map(t=>`<p>${linkifyText(t)}</p>`).join("")}function pulseLike(e){window.matchMedia?.("(prefers-reduced-motion: reduce)").matches||document.querySelectorAll(e).forEach(t=>t.querySelector("svg")?.animate?.([{transform:"scale(1)"},{transform:"scale(1.23)",offset:.45},{transform:"scale(1)"}],{duration:240,easing:"ease-out"}))}function cropBounds(e,t,n,a,o){const i=Math.min(e,t)/Math.max(1,Math.min(4,o));return{side:i,x:Math.max(0,Math.min(e-i,n-i/2)),y:Math.max(0,Math.min(t-i,a-i/2))}}async function cropPhoto(e){const t=URL.createObjectURL(e),n=new Image;try{return n.src=t,await n.decode(),await new Promise(a=>{const o=document.activeElement,i=document.createElement("div");i.className="crop-overlay",i.innerHTML=\'<section class="crop-dialog" role="dialog" aria-modal="true" aria-label="\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0444\u043E\u0442\u043E"><h2>\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0444\u043E\u0442\u043E</h2><p>\u041F\u0435\u0440\u0435\u043C\u0435\u0449\u0430\u0439\u0442\u0435 \u0444\u043E\u0442\u043E \u0432\u043D\u0443\u0442\u0440\u0438 \u0440\u0430\u043C\u043A\u0438. \u041F\u043E\u043B\u0437\u0443\u043D\u043E\u043A \u043C\u0435\u043D\u044F\u0435\u0442 \u043C\u0430\u0441\u0448\u0442\u0430\u0431.</p><div class="crop-stage" tabindex="0" role="group" aria-label="\u041E\u0431\u043B\u0430\u0441\u0442\u044C \u0444\u043E\u0442\u043E. \u041F\u0435\u0440\u0435\u043C\u0435\u0449\u0430\u0439\u0442\u0435 \u0444\u043E\u0442\u043E \u043F\u0430\u043B\u044C\u0446\u0435\u043C \u0438\u043B\u0438 \u0441\u0442\u0440\u0435\u043B\u043A\u0430\u043C\u0438"><canvas width="640" height="640"></canvas><div class="crop-frame" aria-hidden="true"></div></div><label class="crop-scale">\u041C\u0430\u0441\u0448\u0442\u0430\u0431<input type="range" min="1" max="4" step="0.01" value="1" aria-label="\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0444\u043E\u0442\u043E"></label><div class="crop-actions"><button class="auth-switch" data-crop-cancel>\u041E\u0442\u043C\u0435\u043D\u0430</button><button class="primary" data-crop-save>\u0413\u043E\u0442\u043E\u0432\u043E</button></div></section>\',document.body.append(i);const s=i.querySelector(".crop-stage"),r=i.querySelector("canvas"),l=i.querySelector("input"),c=i.querySelector("[data-crop-save]");let u=n.naturalWidth/2,m=n.naturalHeight/2,p=1,f=null,b=!1;const g=()=>{const d=cropBounds(n.naturalWidth,n.naturalHeight,u,m,p);u=d.x+d.side/2,m=d.y+d.side/2,r.getContext("2d").drawImage(n,d.x,d.y,d.side,d.side,0,0,640,640)},v=d=>{b||(b=!0,i.remove(),o?.focus?.(),a(d))};g(),l.oninput=()=>{p=Number(l.value),g()},s.onpointerdown=d=>{f||d.button>0||(f={id:d.pointerId,x:d.clientX,y:d.clientY,cx:u,cy:m,side:cropBounds(n.naturalWidth,n.naturalHeight,u,m,p).side},s.setPointerCapture?.(d.pointerId))},s.onpointermove=d=>{if(!f||d.pointerId!==f.id)return;const h=f.side/s.getBoundingClientRect().width;u=f.cx-(d.clientX-f.x)*h,m=f.cy-(d.clientY-f.y)*h,g()},s.onpointerup=s.onpointercancel=()=>{f=null},s.onkeydown=d=>{const h={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!h[d.key])return;d.preventDefault();const y=Math.min(n.naturalWidth,n.naturalHeight)/p*.025;u+=h[d.key][0]*y,m+=h[d.key][1]*y,g()},i.addEventListener("keydown",d=>{if(d.stopPropagation(),d.key==="Escape"&&v(null),d.key==="Tab"){const h=[...i.querySelectorAll(\'button,input,[tabindex="0"]\')],y=h[0],w=h.at(-1);d.shiftKey&&document.activeElement===y?(d.preventDefault(),w.focus()):!d.shiftKey&&document.activeElement===w&&(d.preventDefault(),y.focus())}}),i.querySelector("[data-crop-cancel]").onclick=()=>v(null),c.onclick=()=>{c.disabled=!0;const d=cropBounds(n.naturalWidth,n.naturalHeight,u,m,p),h=document.createElement("canvas");h.width=h.height=Math.min(1280,Math.round(d.side)),h.getContext("2d").drawImage(n,d.x,d.y,d.side,d.side,0,0,h.width,h.height),h.toBlob(y=>{if(!y){c.disabled=!1,toast("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C \u0444\u043E\u0442\u043E");return}v(y)},"image/jpeg",.9)},s.focus()})}finally{URL.revokeObjectURL(t)}}let copyReadyAt=0;const expandedPosts=new Set;function postTextHTML(e){const t=e.text.split(`\n`),n=e.text.length>420||t.length>7;let a=e.text;return n&&!expandedPosts.has(e.id)&&(a=t.slice(0,7).join(`\n`).slice(0,420).trimEnd()+"\u2026"),postParagraphs(a)+(n?`<button class="read-more" onclick="togglePostText(\'${e.id}\')" aria-expanded="${expandedPosts.has(e.id)}">${expandedPosts.has(e.id)?"\u0421\u0432\u0435\u0440\u043D\u0443\u0442\u044C":"\u0427\u0438\u0442\u0430\u0442\u044C \u0434\u0430\u043B\u0435\u0435"}</button>`:"")}function togglePostText(e){expandedPosts.has(e)?expandedPosts.delete(e):expandedPosts.add(e);const t=findPost(e);t&&document.querySelectorAll(`[data-post-id="${e}"] .posttext`).forEach(n=>{n.innerHTML=postTextHTML(t),n.scrollTop=0})}function inviteQuotaHTML(e){return`<div class="invite-quota"><strong>${e.used}<span> / ${e.limit??"\u221E"}</span></strong><span>\u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u043E \u0434\u0440\u0443\u0437\u0435\u0439</span></div>`}function presenceLabel(e){if(e.own&&me?.invisible)return"\u0412\u044B \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 \u043D\u0435\u0432\u0438\u0434\u0438\u043C\u043A\u0438";if(e.online||e.own&&!me?.invisible)return"\u041E\u043D\u043B\u0430\u0439\u043D";if(!e.lastSeen)return"\u0411\u044B\u043B(\u0430) \u0432 \u0441\u0435\u0442\u0438 \u043D\u0435\u0434\u0430\u0432\u043D\u043E";const t=Math.max(0,Math.floor(Date.now()/1e3)-e.lastSeen);if(t<60)return"\u0411\u044B\u043B(\u0430) \u0432 \u0441\u0435\u0442\u0438 \u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E";const n=t<3600?Math.floor(t/60):t<86400?Math.floor(t/3600):Math.floor(t/86400),a=t<3600?["\u043C\u0438\u043D\u0443\u0442\u0443","\u043C\u0438\u043D\u0443\u0442\u044B","\u043C\u0438\u043D\u0443\u0442"]:t<86400?["\u0447\u0430\u0441","\u0447\u0430\u0441\u0430","\u0447\u0430\u0441\u043E\u0432"]:["\u0441\u0443\u0442\u043A\u0438","\u0441\u0443\u0442\u043E\u043A","\u0441\u0443\u0442\u043E\u043A"],o=n%100>=11&&n%100<=14?a[2]:n%10===1?a[0]:n%10>=2&&n%10<=4?a[1]:a[2];return`\u0411\u044B\u043B(\u0430) \u0432 \u0441\u0435\u0442\u0438 ${n} ${o} \u043D\u0430\u0437\u0430\u0434`}async function saveInvisible(e){const t=e.checked;e.disabled=!0;try{await api("/reef-api/settings",{method:"PUT",body:JSON.stringify({invisible:t})}),me.invisible=t,me.online=!t,t||updatePresence(!0).catch(()=>{}),profile?.own&&(profile.online=!t,setProfilePresence(!t))}catch(n){e.checked=!t,toast(n.message)}finally{e.disabled=!1}}function toggleDraftPoll(){draft.poll=draft.poll?null:["",""],renderPollEditor()}function renderPollEditor(){const e=document.getElementById("poll-editor");e&&(e.innerHTML=draft.poll?`<section class="poll-editor"><div class="poll-editor-title">\u041E\u043F\u0440\u043E\u0441 <button onclick="toggleDraftPoll()" aria-label="\u0423\u0431\u0440\u0430\u0442\u044C \u043E\u043F\u0440\u043E\u0441">\xD7</button></div><p>\u0412\u043E\u043F\u0440\u043E\u0441 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0432 \u0442\u0435\u043A\u0441\u0442\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438.</p>${draft.poll.map((t,n)=>`<input maxlength="100" value="${esc(t)}" placeholder="\u0412\u0430\u0440\u0438\u0430\u043D\u0442 ${n+1}" aria-label="\u0412\u0430\u0440\u0438\u0430\u043D\u0442 ${n+1}" oninput="draft.poll[${n}]=this.value">`).join("")}<div class="poll-editor-tools">${draft.poll.length<6?`<button onclick="draft.poll.push(\'\');renderPollEditor()">+ \u0412\u0430\u0440\u0438\u0430\u043D\u0442</button>`:""}${draft.poll.length>2?\'<button onclick="draft.poll.pop();renderPollEditor()">\u0423\u0431\u0440\u0430\u0442\u044C \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439</button>\':""}</div></section>`:"")}function pollHTML(e){if(!e.poll)return"";const t=e.poll;return`<section class="post-poll" data-poll="${e.id}"><small>\u041E\u043F\u0440\u043E\u0441 \xB7 \u043E\u0434\u0438\u043D \u043E\u0442\u0432\u0435\u0442</small>${t.options.map((n,a)=>{const o=t.total?Math.round(n.votes/t.total*100):0;return`<button class="poll-option ${t.selected===a?"selected":""}" onclick="votePoll(\'${e.id}\',${a})" aria-pressed="${t.selected===a}"><span class="poll-bar" style="width:${o}%"></span><span>${esc(n.text)}</span><strong>${t.selected!==null?o+"%":""}</strong></button>`}).join("")}<button class="poll-voters" onclick="showPollVoters(\'${e.id}\')">${t.total} \u0433\u043E\u043B\u043E\u0441\u043E\u0432 \xB7 \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C</button><small>${t.selected!==null?"\u041C\u043E\u0436\u043D\u043E \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442":""}</small></section>`}function updatePoll(e){document.querySelectorAll(`[data-poll="${e.id}"]`).forEach(t=>{if(!e.poll){t.remove();return}const n=[...t.querySelectorAll(".poll-bar")].map(o=>o.style.width),a=htmlNode(pollHTML(e));t.replaceWith(a),window.matchMedia?.("(prefers-reduced-motion: reduce)").matches||a.querySelectorAll(".poll-bar").forEach((o,i)=>o.animate?.([{width:n[i]||"0%"},{width:o.style.width}],{duration:450,easing:"cubic-bezier(.2,.7,.2,1)"}))})}async function votePoll(e,t){if(!busy.has("poll:"+e)){busy.add("poll:"+e);try{const n=await api("/reef-api/posts/"+e+"/vote",{method:"PUT",body:JSON.stringify({option:t})}),a=findPost(e);a&&(a.poll=n.poll,a._liveVersion=(a._liveVersion||0)+1,updatePoll(a))}catch(n){toast(n.message)}finally{busy.delete("poll:"+e)}}}async function likeMessage(e){if(busy.has("message:"+e))return;const t=chatMessages.find(n=>n.id===e);if(t){busy.add("message:"+e);try{const n=await api("/reef-api/messages/"+e+"/like",{method:"PUT",body:JSON.stringify({liked:!t.liked})});Object.assign(t,n);const a=document.querySelector(`[data-message-id="${e}"] .message-like`);a&&(a.classList.toggle("liked",t.liked),a.setAttribute("aria-pressed",t.liked),a.querySelector("span").textContent=t.likes||"",pulseLike(`[data-message-id="${e}"] .message-like`))}catch(n){toast(n.message)}finally{busy.delete("message:"+e)}}}let lastAnimatedView="feed",screenAnimations=[];function queueScreenAnimation(){const e=view;Promise.resolve().then(()=>{if(view!==e||lastAnimatedView===e)return;const t=lastAnimatedView;lastAnimatedView=e,screenAnimations.forEach(i=>i.cancel?.()),screenAnimations=[];const n=["inbox","feed","profile"];if(!n.includes(t)||!n.includes(e)||e==="profile"&&!profile?.own||window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)return;const a={inbox:0,feed:1,profile:2},o=(a[e]??3)>=(a[t]??0)?1:-1;for(const i of screenAnimationTargets()){const s=i.animate?.([{opacity:.2,transform:`translateX(${o*Math.min(140,(main.clientWidth||360)*.38)}px)`},{opacity:1,transform:"translateX(0)"}],{duration:420,easing:"cubic-bezier(.2,.75,.25,1)"});s&&screenAnimations.push(s)}})}async function returnToSettings(){await openProfile(me.id),openAccountMenu()}function tabSwipeTarget(e,t){const n=["inbox","feed","profile"],a=n.indexOf(e);return a<0?null:n[a+(t>0?-1:1)]||null}let tabGesture=null,tabSwipeBusy=!1,suppressTabClickUntil=0;main.addEventListener("touchstart",e=>{if(tabGesture=null,!me||tabSwipeBusy||e.touches.length!==1||!["feed","inbox","profile"].includes(view)||view==="profile"&&!profile?.own||document.getElementById("modalroot").innerHTML||document.getElementById("lightboxroot").innerHTML||document.querySelector(".crop-overlay"))return;const t=e.target;if(t.closest("a,input,textarea,select,video,.post-poll,.comments")||t.closest("button")&&!t.closest(".chat-row,.grid-tile"))return;const n=t.closest(".gallery");if(n&&Number(n.dataset.count)>1)return;const a=e.touches[0];a.clientX<24||a.clientX>(window.innerWidth||document.documentElement.clientWidth||1e3)-24||(tabGesture={x:a.clientX,y:a.clientY,time:Date.now(),screen:view,locked:!1,dx:0})},{passive:!0}),main.addEventListener("touchmove",e=>{const t=tabGesture;if(!t)return;if(e.touches.length!==1||t.screen!==view){tabGesture=null;return}const n=e.touches[0],a=n.clientX-t.x,o=n.clientY-t.y;if(!t.locked){if(Math.abs(o)>12&&Math.abs(o)>=Math.abs(a)){tabGesture=null;return}Math.abs(a)>12&&Math.abs(a)>Math.abs(o)*1.5&&tabSwipeTarget(t.screen,a)&&(t.locked=!0)}t.locked&&(t.dx=a,clearTimeout(photoTapTimer),suppressPhotoUntil=Date.now()+600,postTouch=null,lastPostTap=null,e.cancelable&&e.preventDefault())},{passive:!1}),main.addEventListener("touchend",async e=>{const t=tabGesture;if(tabGesture=null,!t?.locked||!e.changedTouches.length)return;const n=e.changedTouches[0],a=n.clientX-t.x,o=n.clientY-t.y,i=Date.now()-t.time,s=Math.min(90,Math.max(56,(main.clientWidth||360)*.16));if(Math.abs(a)<s&&!(Math.abs(a)>36&&Math.abs(a)/Math.max(1,i)>.4)||Math.abs(a)<Math.abs(o)*1.5)return;const r=tabSwipeTarget(t.screen,a);if(!(!r||view!==t.screen)){suppressTabClickUntil=Date.now()+500,suppressPhotoUntil=Date.now()+600,clearTimeout(photoTapTimer),tabSwipeBusy=!0;try{r==="feed"?backToFeed():r==="inbox"?await openInbox():await openProfile(me.id)}finally{tabSwipeBusy=!1}}},{passive:!0}),main.addEventListener("touchcancel",()=>{tabGesture=null},{passive:!0}),main.addEventListener("click",e=>{Date.now()<suppressTabClickUntil&&(e.preventDefault(),e.stopImmediatePropagation())},!0);function syncNavigationLayer(){const e=document.querySelector(".floating-actions");if(!(!e||typeof e.showPopover!="function"))try{e.hasAttribute("popover")||e.setAttribute("popover","manual"),e.hidden||!me||document.querySelector("#modalroot .modalback,#lightboxroot .lightbox,.crop-overlay,.insta-zoom-overlay,.square-overlay")?e.matches(":popover-open")&&e.hidePopover():e.matches(":popover-open")||e.showPopover()}catch{e.removeAttribute("popover")}}if(typeof MutationObserver<"u"){const e=new MutationObserver(syncNavigationLayer);e.observe(document.getElementById("modalroot"),{childList:!0}),e.observe(document.getElementById("lightboxroot"),{childList:!0}),e.observe(document.body,{childList:!0})}syncNavigationLayer();function scrollMain(e,t){main.scrollTo?main.scrollTo(e,t):main.scrollTop=Number(t)||0}function screenAnimationTargets(){return[main]}function reefLoader(){return\'<span class="reef-loader" role="status" aria-label="\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0439"><span class="reef-loader-rings" aria-hidden="true"><span></span><span></span></span><span class="sr-only">\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0439</span></span>\'}let feedPosition=null;function rememberFeedPosition(){const e=Number(main.scrollTop)||0,t=main.getBoundingClientRect?.().top||0;let n=null;for(const a of main.querySelectorAll("#feed-list>.post")){const o=a.getBoundingClientRect?.();if(o&&o.bottom>t){n={id:a.dataset.postId,offset:o.top-t};break}}feedPosition={top:e,anchor:n}}function restoreFeedPosition(){if(!feedPosition){scrollMain(0,0);return}scrollMain(0,feedPosition.top);const{anchor:e}=feedPosition;if(!e)return;const t=[...main.querySelectorAll("#feed-list>.post")].find(n=>n.dataset.postId===e.id);if(t?.getBoundingClientRect){const n=main.getBoundingClientRect?.().top||0,a=t.getBoundingClientRect().top-n-e.offset;Math.abs(a)>1&&scrollMain(0,(Number(main.scrollTop)||0)+a)}}function updateCentralIcon(e,t,n,a){if(e.dataset.symbol===t)return;const o=e.dataset.symbol;e._iconAnimations?.forEach(f=>f.cancel?.()),e._iconAnimations=[],e.dataset.symbol=t;const i=o&&!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;e.innerHTML=`<span class="central-icon-window" aria-hidden="true">${i?`<span class="central-icon central-icon-out">${svg(o)}</span>`:""}<span class="central-icon central-icon-in">${svg(t)}</span></span>`;const s=e.querySelector(".central-icon-out"),r=e.querySelector(".central-icon-in");if(!s)return;const l={inbox:0,chat:0,feed:1,profile:2},c=(l[a]??1)>=(l[n]??1)?1:-1,u={duration:420,easing:"cubic-bezier(.2,.75,.25,1)"},m=r.animate?.([{opacity:0,transform:`translateX(${c*32}px)`},{opacity:1,transform:"translateX(0)"}],u),p=s.animate?.([{opacity:1,transform:"translateX(0)"},{opacity:0,transform:`translateX(${-c*32}px)`}],u);m?(m.onfinish=()=>s.remove(),e._iconAnimations.push(m),p&&e._iconAnimations.push(p)):s.remove()}function showEmailAuth(e=!1,t=null,n=""){view="auth",showActions(!1),emailChallenge=null,main.innerHTML=`<section class="auth-card"><div class="reef-wordmark">Reef</div><h1>${e?"\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C":"\u0412\u043E\u0439\u0442\u0438 \u0432 Reef"}</h1>${e&&t?`<p>${esc(t.name)} \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0430\u0435\u0442 \u0432\u0430\u0441 \u0432 \u0441\u0432\u043E\u0439 \u043A\u0440\u0443\u0433.</p>`:""}<form id="email-login-form" onsubmit="requestEmailCode(event,${e})">${e?\'<label for="auth-name">\u0412\u0430\u0448\u0435 \u0438\u043C\u044F</label><input id="auth-name" name="name" minlength="2" maxlength="60" autocomplete="name" required>\':""}<label for="auth-email">\u042D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0430\u044F \u043F\u043E\u0447\u0442\u0430</label><input id="auth-email" type="email" name="email" autocomplete="email" maxlength="254" required placeholder="user@example.com"><p>\u041F\u0440\u0438\u0448\u043B\u0451\u043C \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0439 \u043A\u043E\u0434. \u041F\u0430\u0440\u043E\u043B\u044C \u043D\u0435 \u043D\u0443\u0436\u0435\u043D.</p><div id="auth-error" role="alert">${esc(n)}</div><button id="auth-submit" class="primary" type="submit">\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043A\u043E\u0434</button></form>${e?"":\'<button class="auth-switch" onclick="showFriendCodeForm()">\u0423 \u043C\u0435\u043D\u044F \u0435\u0441\u0442\u044C \u043A\u043E\u0434 \u043E\u0442 \u0434\u0440\u0443\u0433\u0430</button>\'}</section>`}async function requestEmailCode(e,t){if(e.preventDefault(),pendingAuth)return;pendingAuth=!0;const n=document.getElementById("auth-submit");n.disabled=!0,document.getElementById("auth-error").textContent="";try{const a=new FormData(e.target),o=String(a.get("email")).trim(),i=a.get("name")||"";emailChallenge={id:(await api("/reef-api/auth/code/request",{method:"POST",body:JSON.stringify({email:o,name:i,token:inviteToken})})).challenge,email:o,name:i,register:t,ready:Date.now()+6e4},paintEmailCode()}catch(a){document.getElementById("auth-error").textContent=a.message,n.disabled=!1}finally{pendingAuth=!1}}function paintEmailCode(){const e=emailChallenge;main.innerHTML=`<section class="auth-card"><div class="reef-wordmark">Reef</div><h1>\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u043E\u0447\u0442\u0443</h1><p>\u0415\u0441\u043B\u0438 \u0430\u0434\u0440\u0435\u0441 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D \u0438\u043B\u0438 \u0443 \u0432\u0430\u0441 \u0435\u0441\u0442\u044C \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435, \u043A\u043E\u0434 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u043D\u0430 <strong>${esc(e.email)}</strong>. \u041E\u043D \u0434\u0435\u0439\u0441\u0442\u0432\u0443\u0435\u0442 10 \u043C\u0438\u043D\u0443\u0442. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0442\u0430\u043A\u0436\u0435 \u043F\u0430\u043F\u043A\u0443 \xAB\u0421\u043F\u0430\u043C\xBB.</p><form onsubmit="verifyEmailCode(event)"><label for="auth-code">\u041A\u043E\u0434 \u0438\u0437 \u043F\u0438\u0441\u044C\u043C\u0430</label><input id="auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="000000"><div id="auth-error" role="alert"></div><button id="auth-submit" class="primary">\u0412\u043E\u0439\u0442\u0438</button></form><button class="auth-switch" onclick="showEmailAuth(${!!e.register})">\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u043E\u0447\u0442\u0443 \u0438\u043B\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u043A\u043E\u0434</button><p>\u041F\u043E\u0432\u0442\u043E\u0440\u043D\u044B\u0439 \u043A\u043E\u0434 \u043C\u043E\u0436\u043D\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u044C \u0447\u0435\u0440\u0435\u0437 \u043C\u0438\u043D\u0443\u0442\u0443.</p></section>`,document.getElementById("auth-code")?.focus()}async function verifyEmailCode(e){if(e.preventDefault(),pendingAuth||!emailChallenge)return;pendingAuth=!0;const t=document.getElementById("auth-submit");t.disabled=!0;try{me=(await api("/reef-api/auth/code/verify",{method:"POST",body:JSON.stringify({challenge:emailChallenge.id,code:String(new FormData(e.target).get("code"))})})).user,state.depth=me.depth,state.muted=me.muted,inviteToken="",emailChallenge=null,sessionStorage.removeItem("reef-invite"),view="feed",actions(),await restoreRoute(),afterLogin()}catch(n){document.getElementById("auth-error").textContent=n.message,t.disabled=!1}finally{pendingAuth=!1}}const commentReplies=new Map;let peoplePanel=null,tagEditor=null,photoPinch=null;icons.trash=\'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>\';function resizeComposerText(e){e&&(e.style.height="auto",e.style.height=Math.min(320,Math.max(150,e.scrollHeight||150))+"px")}function setUploadProgress(e,t,n,a){const o=document.getElementById("upload-status");o&&(o.innerHTML=`<div class="upload-progress"><span class="upload-progress-icon">${svg(n===100?"check":"image")}</span><span><strong>${esc(a)}</strong><small>\u0424\u0430\u0439\u043B ${e} \u0438\u0437 ${t} \xB7 ${Math.round(n)}%</small><span class="upload-progress-track"><span style="width:${Math.max(2,n)}%"></span></span></span></div>`)}function linkifyText(e){let t="",n=0;const a=/(?:https?:\\/\\/|www\\.)[^\\s<>"\']+/gi;for(const o of String(e).matchAll(a)){t+=esc(String(e).slice(n,o.index));let i=o[0],s="";for(;/[.,!?;:]$/.test(i);)s=i.slice(-1)+s,i=i.slice(0,-1);for(;i.endsWith(")")&&(i.match(/\\(/g)||[]).length<(i.match(/\\)/g)||[]).length;)s=")"+s,i=i.slice(0,-1);try{const r=new URL(i.startsWith("www.")?"https://"+i:i);if(!["http:","https:"].includes(r.protocol))throw Error();t+=`<a href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${esc(i)}</a>`+esc(s)}catch{t+=esc(o[0])}n=o.index+o[0].length}return t+esc(String(e).slice(n))}function replyToComment(e,t){const n=commentCache.get(e)?.find(s=>s.id===t);if(!n)return;const a=document.querySelector(`[data-post-id="${e}"] .comment-form input`),o=a?.value||"";commentReplies.set(e,{id:t,name:n.name}),updateComments(e);const i=document.querySelector(`[data-post-id="${e}"] .comment-form input`);i&&(i.value=o,i.focus())}function clearCommentReply(e){const t=document.querySelector(`[data-post-id="${e}"] .comment-form input`),n=t?.value||"";commentReplies.delete(e),updateComments(e);const a=document.querySelector(`[data-post-id="${e}"] .comment-form input`);a&&(a.value=n)}function hiddenFromHTML(e){return e.author!==me?.id||!e.hiddenFrom?.length?"":`<details class="post-hidden-from"><summary>${svg("lock")}\u0421\u043A\u0440\u044B\u0442\u043E \u043E\u0442: ${esc(e.hiddenFrom.slice(0,2).map(t=>t.name).join(", "))}${e.hiddenFrom.length>2?" \u0438 \u0435\u0449\u0451 "+(e.hiddenFrom.length-2):""}</summary><p>${esc(e.hiddenFrom.map(t=>t.name).join(", "))}</p></details>`}function confirmDeletePost(e){modal("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u044D\u0442\u043E\u0442 \u043C\u043E\u043C\u0435\u043D\u0442?",`<div class="delete-post-confirm">${svg("trash")}<p>\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F, \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438 \u0438 \u0440\u0435\u0430\u043A\u0446\u0438\u0438 \u0431\u0443\u0434\u0443\u0442 \u0443\u0434\u0430\u043B\u0435\u043D\u044B. \u042D\u0442\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043D\u0435\u043B\u044C\u0437\u044F \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C.</p><button class="danger-button" onclick="deletePost(\'${e}\')">\u0414\u0430, \u0443\u0434\u0430\u043B\u0438\u0442\u044C</button><button class="secondary-button" onclick="closeModal()">\u041E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E</button></div>`)}function showMessageRestriction(){modal("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0437\u043D\u0430\u043A\u043E\u043C\u044C\u0442\u0435\u0441\u044C",`<div class="message-restriction">${svg("comment")}<h3>\u0420\u0430\u0437\u0433\u043E\u0432\u043E\u0440 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441 \u0438\u043D\u0442\u0435\u0440\u0435\u0441\u0430</h3><p>\u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435\u0441\u044C \u0432 \u0434\u0440\u0443\u0437\u044C\u044F \u0438\u043B\u0438 \u043F\u0440\u043E\u044F\u0432\u0438\u0442\u0435 \u0432\u0437\u0430\u0438\u043C\u043D\u044B\u0439 \u0438\u043D\u0442\u0435\u0440\u0435\u0441: \u043A\u0430\u0436\u0434\u044B\u0439 \u0434\u043E\u043B\u0436\u0435\u043D \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u043B\u0430\u0439\u043A \u0438\u043B\u0438 \u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u043A \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u0434\u0440\u0443\u0433\u043E\u0433\u043E.</p><button class="primary" onclick="closeModal()">\u041F\u043E\u043D\u044F\u0442\u043D\u043E</button></div>`)}function setAvatarOnline(e,t){const n=e.querySelector(".avatar-online");t&&!n?e.insertAdjacentHTML("beforeend",\'<span class="avatar-online" aria-label="\u041E\u043D\u043B\u0430\u0439\u043D"></span>\'):t||n?.remove()}async function showPostLikes(e){peoplePanel={path:"/reef-api/posts/"+e+"/likers",title:"\u041F\u043E\u043D\u0440\u0430\u0432\u0438\u043B\u043E\u0441\u044C",next:null,options:null},modal(peoplePanel.title,\'<div id="people-list"></div><div id="people-more"></div>\'),await loadPeoplePanel(!0)}async function showPollVoters(e){peoplePanel={path:"/reef-api/posts/"+e+"/voters",title:"\u0413\u043E\u043B\u043E\u0441\u0430 \u0432 \u043E\u043F\u0440\u043E\u0441\u0435",next:null,options:null},modal(peoplePanel.title,\'<div id="people-list"></div><div id="people-more"></div>\'),await loadPeoplePanel(!0)}async function loadPeoplePanel(e=!1){if(!peoplePanel||busy.has("people-panel"))return;busy.add("people-panel");const t=peoplePanel;try{const n=await api(t.path+(!e&&t.next?"?after="+encodeURIComponent(t.next):""));if(t!==peoplePanel||!document.getElementById("people-list"))return;t.next=n.next,t.options=n.options||null;const a=n.people.map(i=>`<button class="people-row" onclick="openProfile(\'${i.id}\')">${avatar(i)}<span><strong>${esc(i.name)}</strong>${n.options?`<small>${esc(n.options[i.option])}</small>`:""}</span>${svg("chevron")}</button>`).join(""),o=document.getElementById("people-list");e&&(o.innerHTML=""),o.insertAdjacentHTML("beforeend",a||\'<p class="people-empty">\u041F\u043E\u043A\u0430 \u043D\u0438\u043A\u043E\u0433\u043E</p>\'),document.getElementById("people-more").innerHTML=n.next?\'<button class="secondary-button" onclick="loadPeoplePanel()">\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0435\u0449\u0451</button>\':""}catch(n){toast(n.message)}finally{busy.delete("people-panel")}}function photoTagDots(e,t){return(e.tags||[]).filter(n=>n.mediaId===t).map(n=>`<button class="photo-tag-dot" style="left:${n.x*100}%;top:${n.y*100}%" onclick="event.stopPropagation();showPhotoTag(event,\'${e.id}\',\'${n.id}\')" aria-label="\u041D\u0430 \u0444\u043E\u0442\u043E ${esc(n.name)}">${svg("user")}</button>`).join("")}function updatePhotoTags(e){if(!document.activeElement?.closest?.(".photo-tag-card"))for(const t of e.media||[])document.querySelectorAll(`[data-post-id="${e.id}"] [data-photo-tags="${t.id}"]`).forEach(n=>n.innerHTML=photoTagDots(e,t.id))}async function showPhotoTag(e,t,n){const a=e.currentTarget.closest(".photo-tags");document.querySelectorAll(".photo-tag-card").forEach(o=>o.remove());try{const o=await api("/reef-api/posts/"+t+"/tags"),i=findPost(t);i&&(i.tags=o.tags);const s=o.tags.find(l=>l.id===n);if(!s||!a?.isConnected)return;const r=document.createElement("div");r.className="photo-tag-card",r.style.left=Math.min(76,Math.max(24,s.x*100))+"%",s.y>.55?r.style.bottom=(1-s.y)*100+10+"%":r.style.top=s.y*100+10+"%",r.innerHTML=`<button class="photo-tag-person" onclick="openProfile(\'${s.member}\')">${avatar(s)}<strong>${esc(s.name)}</strong></button>${s.member===me.id?`<textarea maxlength="140" aria-label="\u041F\u043E\u0434\u043F\u0438\u0441\u044C \u043D\u0430 \u0444\u043E\u0442\u043E" placeholder="\u0412\u0430\u0448\u0438 \u0441\u043B\u043E\u0432\u0430 \u043E\u0431 \u044D\u0442\u043E\u043C \u043C\u043E\u043C\u0435\u043D\u0442\u0435\u2026">${esc(s.comment)}</textarea><small>\u0414\u043E 140 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432</small><button class="photo-tag-save" onclick="saveTagComment(\'${t}\',\'${n}\',this)">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>`:s.comment?`<p>${esc(s.comment)}</p>`:""}`,(i?.author===me.id||s.member===me.id)&&r.insertAdjacentHTML("beforeend",`<div class="tag-card-actions">${i?.author===me.id?`<button onclick="editPublishedTags(\'${t}\',\'${s.mediaId}\')">\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043E\u0442\u043C\u0435\u0442\u043A\u0438</button>`:""}<button onclick="deletePhotoTag(\'${t}\',\'${n}\')">\u0423\u0431\u0440\u0430\u0442\u044C \u043E\u0442\u043C\u0435\u0442\u043A\u0443</button></div>`),a.append(r)}catch(o){toast(o.message)}}async function saveTagComment(e,t,n){if(!n.disabled){n.disabled=!0;try{const a=n.closest(".photo-tag-card").querySelector("textarea").value;await api("/reef-api/photo-tags/"+t,{method:"PUT",body:JSON.stringify({comment:a})});const o=findPost(e)?.tags?.find(i=>i.id===t);o&&(o.comment=a),n.textContent="\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E"}catch(a){toast(a.message)}finally{n.disabled=!1}}}async function tagAttachment(e){const t=draft.attachments[e];if(t)try{const n=await api("/reef-api/audience?depth="+draft.privacy+(draft.global?"&all=1":""));tagEditor={index:e,people:[{id:me.id,name:me.name,avatar:me.avatar},...n.people].filter(a=>!draft.excluded.includes(a.id)),point:null},modal("\u041A\u0442\u043E \u043D\u0430 \u0444\u043E\u0442\u043E?",`<p class="tag-editor-hint">\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043D\u0430 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u043D\u0430 \u0444\u043E\u0442\u043E, \u0437\u0430\u0442\u0435\u043C \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0435\u0433\u043E \u0438\u043C\u044F.</p><div class="tag-editor-photo" style="aspect-ratio:${t.width||1}/${t.height||1}" onclick="placePhotoTag(event,this)"><img src="${esc(t.url)}" alt="\u0424\u043E\u0442\u043E \u0434\u043B\u044F \u043E\u0442\u043C\u0435\u0442\u043A\u0438"><div id="tag-editor-points">${draftTagPoints(t.id)}</div></div><div id="tag-editor-people">${draftTagList(t.id)}</div><button class="primary" onclick="showComposer()">\u0413\u043E\u0442\u043E\u0432\u043E</button>`,"tag-editor-modal")}catch(n){toast(n.message)}}function draftTagPoints(e){return(draft.tags||[]).map((t,n)=>t.mediaId===e?`<button type="button" style="left:${t.x*100}%;top:${t.y*100}%" onclick="event.stopPropagation();selectDraftTag(${n})" aria-label="\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043E\u0442\u043C\u0435\u0442\u043A\u0443">${svg("user")}</button>`:"").join("")}function placePhotoTag(e,t){if(!tagEditor)return;const n=t.getBoundingClientRect();tagEditor.point={x:Math.max(.03,Math.min(.97,(e.clientX-n.left)/n.width)),y:Math.max(.03,Math.min(.97,(e.clientY-n.top)/n.height))},document.getElementById("tag-editor-people").innerHTML=tagEditor.people.map(a=>`<button class="people-row" onclick="addDraftTag(\'${a.id}\')">${avatar(a)}<span>${esc(a.name)}</span></button>`).join("")}function addDraftTag(e){if(!tagEditor?.point)return;const t=draft.attachments[tagEditor.index]?.id;if(!t)return;const n=(draft.tags||[]).find(a=>a.member===e&&a.mediaId===t);if(draft.tags=(draft.tags||[]).filter(a=>!(a.member===e&&a.mediaId===t)),draft.tags.length>=30){toast("\u0414\u043E 30 \u043E\u0442\u043C\u0435\u0442\u043E\u043A \u043D\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E");return}draft.tags.push({...n,mediaId:t,member:e,...tagEditor.point}),document.getElementById("tag-editor-points").innerHTML=draftTagPoints(t),document.getElementById("tag-editor-people").innerHTML=draftTagList(t),tagEditor.point=null}function clearDraftTags(){const e=draft.attachments[tagEditor.index]?.id;draft.tags=(draft.tags||[]).filter(t=>t.mediaId!==e),document.getElementById("tag-editor-points").innerHTML="",document.getElementById("tag-editor-people").innerHTML=""}function showFriendCodeForm(){showActions(!1),view="auth",main.innerHTML=\'<section class="auth-card"><div class="reef-wordmark">Reef</div><h1>\u041A\u043E\u0434 \u043E\u0442 \u0434\u0440\u0443\u0433\u0430</h1><p>\u0412\u0432\u0435\u0434\u0438 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0439 \u043A\u043E\u0434 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F. \u041F\u043E\u0441\u043B\u0435 \u044D\u0442\u043E\u0433\u043E \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043C \u0442\u0432\u043E\u044E \u043F\u043E\u0447\u0442\u0443.</p><form onsubmit="useFriendCode(event)"><label for="friend-code">\u041A\u043E\u0434 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u044F</label><input id="friend-code" name="inviteCode" maxlength="16" autocomplete="off" placeholder="ABCDE-FGHIJ" required><div id="auth-error" role="alert"></div><button class="primary">\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C</button></form><button class="auth-switch" onclick="showAuth()">\u041D\u0430\u0437\u0430\u0434 \u043A\u043E \u0432\u0445\u043E\u0434\u0443</button></section>\'}async function useFriendCode(e){e.preventDefault();const t=e.target.querySelector("button");t.disabled=!0;try{const n=await api("/reef-api/invite/code",{method:"POST",body:JSON.stringify({code:new FormData(e.target).get("inviteCode")})});inviteToken=n.token,sessionStorage.setItem("reef-invite",inviteToken),showAuth(!0,{name:n.name})}catch(n){document.getElementById("auth-error").textContent=n.message,t.disabled=!1}}async function syncFeed(){if(view!=="feed"||loading||busy.has("feed-sync")||!feedReady||document.querySelector(".modalback,.lightbox,.crop-overlay")||document.visibilityState==="hidden")return;busy.add("feed-sync");const e=loadGeneration;try{const t=!state.posts.length,n=new Set(state.posts.map(u=>u.id));let a=await api("/reef-api/posts?limit=8"),o=[],i=0,s=!1;for(;i++<4;){for(const u of a.posts){if(n.has(u.id)){s=!0;break}o.push(u)}if(s||!a.next||!state.posts.length)break;a=await api("/reef-api/posts?limit=8&cursor="+encodeURIComponent(a.next))}if(view!=="feed"||e!==loadGeneration||!o.length)return;if(!s&&state.posts.length&&a.next){showNewPostsPrompt();return}const r=document.getElementById("feed-list");if(!r)return;const l=Number(main.scrollTop)||0,c=main.scrollHeight;state.posts=[...o,...state.posts],r.querySelector(".empty")&&(r.innerHTML=""),r.insertAdjacentHTML("afterbegin",o.map(postHTML).join("")),t&&(feedNext=a.next,document.getElementById("page-sentinel")?.replaceWith(htmlNode(sentinel(feedNext)))),l>40&&scrollMain(0,l+main.scrollHeight-c),observe()}finally{busy.delete("feed-sync")}}function pinchDistance(e){return Math.hypot(e[0].clientX-e[1].clientX,e[0].clientY-e[1].clientY)}function finishPhotoPinch(){if(!photoPinch)return;const e=photoPinch;if(photoPinch=null,window.matchMedia?.("(prefers-reduced-motion: reduce)").matches){e.overlay.remove(),syncNavigationLayer();return}e.image.style.transition="transform .18s ease-out",e.image.style.transform="translate(0,0) scale(1)",e.overlay.style.background="transparent",setTimeout(()=>{e.overlay.remove(),syncNavigationLayer()},180)}document.addEventListener("touchstart",e=>{if(e.touches.length!==2)return;const t=e.target.closest(".photo-static"),n=t?.querySelector("img");if(!n?.src||(tabGesture=null,postTouch=null,lastPostTap=null,clearTimeout(photoTapTimer),suppressPhotoUntil=Date.now()+800,e.cancelable&&e.preventDefault(),photoPinch))return;const a=n.getBoundingClientRect(),o=(e.touches[0].clientX+e.touches[1].clientX)/2,i=(e.touches[0].clientY+e.touches[1].clientY)/2,s=document.createElement("div"),r=n.cloneNode();if(s.className="insta-zoom-overlay",r.removeAttribute("width"),r.removeAttribute("height"),r.style.cssText=`position:fixed;left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px;object-fit:contain;border-radius:16px;transform-origin:${o-a.left}px ${i-a.top}px;`,s.append(r),document.body.append(s),photoPinch={overlay:s,image:r,distance:pinchDistance(e.touches),x:o,y:i},t.dataset.full&&t.dataset.full!==n.src){const l=new Image;l.src=t.dataset.full,typeof l.decode=="function"&&l.decode().then(()=>{photoPinch?.image===r&&(r.src=l.src)}).catch(()=>{})}syncNavigationLayer()},{passive:!1}),document.addEventListener("touchmove",e=>{if(!photoPinch||e.touches.length<2)return;e.cancelable&&e.preventDefault();const t=photoPinch,n=Math.max(1,Math.min(4,pinchDistance(e.touches)/t.distance)),a=(e.touches[0].clientX+e.touches[1].clientX)/2,o=(e.touches[0].clientY+e.touches[1].clientY)/2;t.image.style.transform=`translate(${a-t.x}px,${o-t.y}px) scale(${n})`,t.overlay.style.background=`rgba(18,15,24,${Math.min(.5,(n-1)*.18)})`},{passive:!1}),document.addEventListener("touchend",e=>{photoPinch&&e.touches.length<2&&finishPhotoPinch()},{passive:!0}),document.addEventListener("touchcancel",finishPhotoPinch,{passive:!0}),document.addEventListener("click",e=>{e.target.closest(".photo-tag-card,.photo-tag-dot")||document.querySelectorAll(".photo-tag-card").forEach(t=>t.remove())});function showNewPostsPrompt(){if(document.querySelector(".new-posts-prompt"))return;const e=document.createElement("button");e.className="new-posts-prompt",e.textContent="\u041D\u043E\u0432\u044B\u0435 \u043C\u043E\u043C\u0435\u043D\u0442\u044B \u2191",e.onclick=()=>{e.remove(),scrollMain(0,0),loadFeed(!0)},main.append(e)}const commentAttachments=new Map,commentUploads=new Set;function commentMediaHTML(e){const t=e.media;return t?t.type.startsWith("video/")?`<video class="comment-media square-video" src="${esc(t.url)}" poster="${esc(t.thumbnail||"")}" controls playsinline preload="none" onplay="pauseOtherVideos(this)" aria-label="\u0412\u0438\u0434\u0435\u043E\u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A"></video>`:`<div class="photo-static comment-photo" data-full="${esc(t.url)}"><img class="comment-media" src="${esc(t.thumbnail||t.url)}" loading="lazy" decoding="async" alt="\u0424\u043E\u0442\u043E \u0432 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438"></div>`:""}function commentComposerHTML(e){if(findPost(e)?.canComment===!1)return\'<p class="comment-restricted">\u0410\u0432\u0442\u043E\u0440 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u043B \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438 \u043A \u044D\u0442\u043E\u0439 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438</p>\';const t=commentAttachments.get(e);return`<div class="comment-attachment-slot" data-comment-attachment="${e}">${commentUploads.has(e)?\'<span class="mini-spinner"></span> \u041F\u043E\u0434\u0433\u043E\u0442\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u043C \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435\u2026\':t?`<img src="${esc(t.thumbnail||t.url)}" alt="\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u0435"><span>${t.type.startsWith("video/")?"\u0412\u0438\u0434\u0435\u043E\u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A":"\u0424\u043E\u0442\u043E"}</span><button type="button" onclick="removeCommentAttachment(\'${e}\')" aria-label="\u0423\u0431\u0440\u0430\u0442\u044C \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435">\xD7</button>`:""}</div>`}function refreshCommentDraft(e){const t=document.querySelector(`[data-post-id="${e}"] .comment-form input`),n=t?.value||"";updateComments(e);const a=document.querySelector(`[data-post-id="${e}"] .comment-form input`);a&&(a.value=n)}function removeCommentAttachment(e){commentAttachments.delete(e),refreshCommentDraft(e)}function pickCommentMedia(e){if(findPost(e)?.canComment===!1)return;const t=document.createElement("input");t.type="file",t.accept="image/*",t.onchange=()=>{t.files[0]&&uploadCommentAttachment(e,t.files[0])},t.click()}async function uploadCommentAttachment(e,t,n=null){if(!commentUploads.has(e)){if(findPost(e)?.canComment===!1){toast("\u0410\u0432\u0442\u043E\u0440 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u043B \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438");return}commentUploads.add(e),refreshCommentDraft(e);try{if(!n&&(!t.type.startsWith("image/")||t.size>50*1024*1024))throw Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0444\u043E\u0442\u043E \u0434\u043E 50 \u041C\u0411");const a=await uploadPrepared(n||await prepareImage(t),o=>{const i=document.querySelector(`[data-comment-attachment="${e}"]`);i&&(i.innerHTML=`<span class="mini-spinner"></span> \u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \xB7 ${o}%`)});commentAttachments.set(e,a)}catch(a){toast(a.message)}finally{commentUploads.delete(e),refreshCommentDraft(e)}}}function highlightComment(e,t){const n=[...document.querySelectorAll(`[data-post-id="${e}"] [data-comment-id]`)].find(a=>a.dataset.commentId===t);if(!n){toast("\u042D\u0442\u043E\u0442 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D");return}n.scrollIntoView?.({block:"center",behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"}),n.classList.remove("comment-highlight"),n.offsetWidth,n.classList.add("comment-highlight"),setTimeout(()=>n.classList.remove("comment-highlight"),1800)}function commentPolicyLabel(){const e=draft.commentPolicy||{depth:4,excluded:[]};return["\u0422\u043E\u043B\u044C\u043A\u043E \u0432\u044B","\u0414\u0440\u0443\u0437\u044C\u044F","\u0414\u043E \u0432\u0442\u043E\u0440\u043E\u0433\u043E \u043A\u0440\u0443\u0433\u0430","\u0414\u043E \u0442\u0440\u0435\u0442\u044C\u0435\u0433\u043E \u043A\u0440\u0443\u0433\u0430","\u0412\u0441\u0435, \u043A\u0442\u043E \u0432\u0438\u0434\u0438\u0442 \u043F\u043E\u0441\u0442"][e.depth]+(e.excluded.length?" \xB7 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u044F \u0434\u043B\u044F "+e.excluded.length+" \u0447\u0435\u043B.":"")}async function showCommentPolicy(){try{const e=await api("/reef-api/audience?depth=3"+(draft.global?"&all=1":"")),t=draft.commentPolicy||{depth:4,excluded:[]};modal("\u041A\u0442\u043E \u043C\u043E\u0436\u0435\u0442 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C",`<p class="sub">\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0435\u0432 \u043D\u0435 \u0441\u043A\u0440\u044B\u0432\u0430\u0435\u0442 \u0441\u0430\u043C\u0443 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E.</p><div class="comment-policy-choices">${[4,1,2,3,0].map(n=>`<label class="depth-card"><input type="radio" name="comment-depth" value="${n}" ${t.depth===n?"checked":""}><span>${["\u0422\u043E\u043B\u044C\u043A\u043E \u044F","\u041C\u043E\u0438 \u0434\u0440\u0443\u0437\u044C\u044F","\u0414\u043E \u0432\u0442\u043E\u0440\u043E\u0433\u043E \u043A\u0440\u0443\u0433\u0430","\u0414\u043E \u0442\u0440\u0435\u0442\u044C\u0435\u0433\u043E \u043A\u0440\u0443\u0433\u0430","\u0412\u0441\u0435, \u043A\u0442\u043E \u0432\u0438\u0434\u0438\u0442 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044E"][n]}</span></label>`).join("")}</div><details class="muted-authors"><summary>\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u0442\u044C \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u0445 \u043B\u044E\u0434\u0435\u0439</summary>${e.people.filter(n=>n.id!==me.id).map(n=>`<label class="check"><input type="checkbox" name="comment-excluded" value="${n.id}" ${t.excluded.includes(n.id)?"checked":""}>${esc(n.name)}</label>`).join("")}</details><button class="primary" onclick="saveCommentPolicy()">\u0413\u043E\u0442\u043E\u0432\u043E</button><button class="auth-switch" onclick="showComposer()">\u041D\u0430\u0437\u0430\u0434</button>`,"comment-policy-modal")}catch(e){toast(e.message)}}function saveCommentPolicy(){draft.commentPolicy={depth:Number(document.querySelector(\'[name="comment-depth"]:checked\').value),excluded:[...document.querySelectorAll(\'[name="comment-excluded"]:checked\')].map(e=>e.value)},showComposer()}function messageDateHTML(e,t){const n=new Date(e.created*1e3),a=n.toLocaleDateString("ru-RU");if(t&&new Date(t.created*1e3).toLocaleDateString("ru-RU")===a)return"";const o=new Date,i=new Date;i.setDate(o.getDate()-1);const s=a===o.toLocaleDateString("ru-RU")?"\u0421\u0435\u0433\u043E\u0434\u043D\u044F":a===i.toLocaleDateString("ru-RU")?"\u0412\u0447\u0435\u0440\u0430":n.toLocaleDateString("ru-RU",{day:"numeric",month:"long",...n.getFullYear()!==o.getFullYear()?{year:"numeric"}:{}});return`<div class="chat-date"><time datetime="${n.toISOString().slice(0,10)}">${s}</time></div>`}function draftTagList(e){const t=(draft.tags||[]).map((n,a)=>({...n,index:a})).filter(n=>n.mediaId===e);return t.map(n=>`<div class="draft-tag-row"><span>${esc(tagEditor?.people.find(a=>a.id===n.member)?.name||n.name||"\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A")}</span><button onclick="selectDraftTag(${n.index})">\u041F\u0435\u0440\u0435\u043C\u0435\u0441\u0442\u0438\u0442\u044C</button><button onclick="replaceDraftTag(${n.index})">\u0417\u0430\u043C\u0435\u043D\u0438\u0442\u044C</button><button onclick="removeDraftTag(${n.index})" aria-label="\u0423\u0431\u0440\u0430\u0442\u044C \u043E\u0442\u043C\u0435\u0442\u043A\u0443">\xD7</button></div>`).join("")+(t.length?\'<button class="tag-clear" onclick="clearDraftTags()">\u0423\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435 \u043E\u0442\u043C\u0435\u0442\u043A\u0438</button>\':"")}function selectDraftTag(e){tagEditor&&(tagEditor.moving=e,document.getElementById("tag-editor-people").innerHTML=\'<p class="tag-editor-hint">\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043D\u0430 \u043D\u043E\u0432\u043E\u0435 \u043C\u0435\u0441\u0442\u043E \u043D\u0430 \u0444\u043E\u0442\u043E.</p><button class="tag-clear" onclick="removeDraftTag(\'+e+\')">\u0423\u0431\u0440\u0430\u0442\u044C \u044D\u0442\u0443 \u043E\u0442\u043C\u0435\u0442\u043A\u0443</button>\')}const originalPlacePhotoTag=placePhotoTag;placePhotoTag=function(e,t){if(Number.isInteger(tagEditor?.moving)){const n=t.getBoundingClientRect(),a=draft.tags[tagEditor.moving];a&&(a.x=Math.max(.03,Math.min(.97,(e.clientX-n.left)/n.width)),a.y=Math.max(.03,Math.min(.97,(e.clientY-n.top)/n.height))),delete tagEditor.moving,refreshDraftTags();return}originalPlacePhotoTag(e,t)};function refreshDraftTags(){const e=draft.attachments[tagEditor.index]?.id;document.getElementById("tag-editor-points").innerHTML=draftTagPoints(e),document.getElementById("tag-editor-people").innerHTML=draftTagList(e)}function removeDraftTag(e){draft.tags.splice(e,1),tagEditor&&delete tagEditor.moving,refreshDraftTags()}async function editPublishedTags(e,t){await editPost(e);const n=draft.attachments.findIndex(a=>a.id===t);n>=0&&await tagAttachment(n)}async function deletePhotoTag(e,t){try{await api("/reef-api/photo-tags/"+t,{method:"DELETE"});const n=findPost(e);n&&(n.tags=n.tags.filter(a=>a.id!==t),updatePhotoTags(n))}catch(n){toast(n.message)}}async function cropAttachment(e){if(uploading)return;const t=draft.attachments[e];if(!(!t||t.type.startsWith("video/")))try{const n=await fetch(t.url,{credentials:"same-origin"});if(!n.ok)throw Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0444\u043E\u0442\u043E");const a=await cropPhoto(await n.blob());if(!a)return;uploading=!0;const o=await uploadPrepared(await prepareImage(a));draft.attachments[e]=o,draft.tags=(draft.tags||[]).filter(i=>i.mediaId!==t.id),renderAttachments()}catch(n){toast(n.message)}finally{uploading=!1}}let squareSession=null;function squareMime(){return["video/webm;codecs=vp8,opus","video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/webm","video/mp4"].find(e=>window.MediaRecorder?.isTypeSupported(e))}function squareDraw(e,t){const n=e.videoWidth,a=e.videoHeight;if(!n||!a)return;const o=Math.min(n,a);t.getContext("2d").drawImage(e,(n-o)/2,(a-o)/2,o,o,0,0,t.width,t.height)}function squareOverlay(){const e=document.createElement("div");return e.className="square-overlay",e.innerHTML=\'<section class="square-recorder" role="dialog" aria-modal="true" aria-label="\u0412\u0438\u0434\u0435\u043E\u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A"><button class="square-close" aria-label="\u0417\u0430\u043A\u0440\u044B\u0442\u044C" onclick="closeSquareRecorder()">\xD7</button><h2>\u041A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A</h2><p>\u041E\u0434\u0438\u043D \u043C\u043E\u043C\u0435\u043D\u0442. \u0414\u043E \u043E\u0434\u043D\u043E\u0439 \u043C\u0438\u043D\u0443\u0442\u044B.</p><div class="square-stage"><video autoplay muted playsinline></video><canvas width="480" height="480"></canvas></div><div class="square-status" aria-live="polite">\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043A\u0430\u043C\u0435\u0440\u0435</div><div class="square-controls"><button class="square-record" onclick="toggleSquareRecording()" aria-label="\u041D\u0430\u0447\u0430\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C">\u25CF</button></div><button class="auth-switch" onclick="chooseSquareFile()">\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E</button></section>\',document.body.append(e),e}async function openSquareRecorder(e=null){if(uploading||e&&commentUploads.has(e))return;if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream){toast("\u0414\u043B\u044F \u0437\u0430\u043F\u0438\u0441\u0438 \u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A\u043E\u0432 \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 Reef \u0432 \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u043E\u043C Chrome \u0438\u043B\u0438 Safari");return}squareSession&&closeSquareRecorder();const t={comment:e,overlay:squareOverlay(),stream:null,recorder:null,frame:null,started:0,blob:null};squareSession=t;try{const n=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:640},height:{ideal:640}},audio:!0});if(squareSession!==t){n.getTracks().forEach(i=>i.stop());return}if(t.importing){n.getTracks().forEach(i=>i.stop());return}t.stream=n;const a=t.overlay.querySelector("video");a.srcObject=n,await a.play();const o=()=>{squareSession===t&&(squareDraw(a,t.overlay.querySelector("canvas")),t.frame=requestAnimationFrame(o))};o(),t.overlay.querySelector(".square-status").textContent="\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u25CF, \u0447\u0442\u043E\u0431\u044B \u043D\u0430\u0447\u0430\u0442\u044C"}catch{squareSession===t&&(t.overlay.querySelector(".square-status").textContent="\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u043A\u0430\u043C\u0435\u0440\u0443 \u0438 \u043C\u0438\u043A\u0440\u043E\u0444\u043E\u043D \u0438\u043B\u0438 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0433\u043E\u0442\u043E\u0432\u043E\u0435 \u0432\u0438\u0434\u0435\u043E")}}function closeSquareRecorder(){const e=squareSession;e&&(squareSession=null,e.recorder?.state==="recording"&&(e.cancelled=!0,e.recorder.stop()),cancelAnimationFrame(e.frame),clearInterval(e.timer),e.stream?.getTracks().forEach(t=>t.stop()),e.capture?.getTracks().forEach(t=>t.stop()),e.previewUrl&&URL.revokeObjectURL(e.previewUrl),e.overlay.remove())}function toggleSquareRecording(){const e=squareSession;if(!e)return;if(e.recorder?.state==="recording"){e.recorder.stop();return}if(!e.stream){toast("\u041A\u0430\u043C\u0435\u0440\u0430 \u0435\u0449\u0451 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u0430");return}const t=e.overlay.querySelector("canvas"),n=t.captureStream(24);e.capture=n;for(const s of e.stream.getAudioTracks())n.addTrack(s);const a=squareMime();if(!a){toast("\u0411\u0440\u0430\u0443\u0437\u0435\u0440 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u044C \u0432\u0438\u0434\u0435\u043E");return}const o=[],i=new MediaRecorder(n,{mimeType:a,videoBitsPerSecond:6e5,audioBitsPerSecond:64e3});e.recorder=i,e.started=Date.now(),i.ondataavailable=s=>{s.data.size&&o.push(s.data)},i.onerror=()=>{clearInterval(e.timer),toast("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437"),closeSquareRecorder()},i.onstop=()=>{clearInterval(e.timer),!(e.cancelled||squareSession!==e)&&(e.blob=new Blob(o,{type:i.mimeType}),e.duration=Math.max(.1,Math.min(60,(Date.now()-e.started)/1e3)),showSquarePreview(e))},i.start(500),e.overlay.querySelector(".square-record").classList.add("recording"),e.overlay.querySelector(".square-record").setAttribute("aria-label","\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C"),e.timer=setInterval(()=>{const s=Math.floor((Date.now()-e.started)/1e3);e.overlay.querySelector(".square-status").textContent="\u0417\u0430\u043F\u0438\u0441\u044C \xB7 "+s+" / 60 \u0441\u0435\u043A.",s>=60&&i.state==="recording"&&i.stop()},200)}async function showSquarePreview(e){if(squareSession!==e||(cancelAnimationFrame(e.frame),e.thumbnail=await new Promise(n=>e.overlay.querySelector("canvas").toBlob(n,"image/jpeg",.75)),squareSession!==e))return;e.stream?.getTracks().forEach(n=>n.stop()),e.capture?.getTracks().forEach(n=>n.stop());const t=e.overlay.querySelector("video");t.srcObject=null,e.previewUrl=URL.createObjectURL(e.blob),t.src=e.previewUrl,t.controls=!0,t.muted=!1,e.overlay.classList.add("square-preview"),e.overlay.querySelector(".square-status").textContent=`${Math.ceil(e.duration)} \u0441\u0435\u043A. \xB7 ${(e.blob.size/1024/1024).toFixed(1)} \u041C\u0411`,e.overlay.querySelector(".square-controls").innerHTML=\'<button class="secondary-button" onclick="restartSquareRecorder()">\u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C</button><button class="primary" onclick="attachSquareVideo()">\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C</button>\'}function restartSquareRecorder(){const e=squareSession?.comment;closeSquareRecorder(),openSquareRecorder(e)}function chooseSquareFile(){const e=document.createElement("input");e.type="file",e.accept="video/*",e.onchange=()=>{e.files[0]&&compressSquareFile(e.files[0])},e.click()}async function compressSquareFile(e){const t=squareSession;if(!t||t.importing||t.recorder?.state==="recording")return;if(e.size>100*1024*1024){toast("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0438\u0434\u0435\u043E \u0434\u043E 100 \u041C\u0411");return}t.importing=!0,t.stream?.getTracks().forEach(s=>s.stop()),cancelAnimationFrame(t.frame);const n=document.createElement("video"),a=URL.createObjectURL(e);let o=null,i=null;n.src=a,n.playsInline=!0,n.preload="auto",t.overlay.querySelector(".square-status").textContent="\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u0432\u0438\u0434\u0435\u043E\u2026";try{if(await new Promise((f,b)=>{n.onloadedmetadata=f,n.onerror=()=>b(Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E"))}),!Number.isFinite(n.duration)||n.duration<=0||n.duration>60.2)throw Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0438\u0434\u0435\u043E \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C\u044E \u0434\u043E \u043C\u0438\u043D\u0443\u0442\u044B");if(squareSession!==t)return;const s=t.overlay.querySelector("canvas");i=s.captureStream(24);const r=window.AudioContext||window.webkitAudioContext;if(r){o=new r,await o.resume();const f=o.createMediaStreamDestination();o.createMediaElementSource(n).connect(f);for(const b of f.stream.getAudioTracks())i.addTrack(b)}else n.muted=!0;const l=squareMime();if(!l)throw Error("\u0417\u0430\u043F\u0438\u0441\u044C \u0432\u0438\u0434\u0435\u043E \u0432 \u044D\u0442\u043E\u043C \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");const c=new MediaRecorder(i,{mimeType:l,videoBitsPerSecond:6e5,audioBitsPerSecond:64e3}),u=[];t.recorder=c,t.duration=Math.min(60,n.duration);const m=new Promise((f,b)=>{c.ondataavailable=g=>{g.data.size&&u.push(g.data)},c.onerror=()=>b(Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u0436\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E")),c.onstop=f});c.start(500);const p=()=>{squareSession===t&&(squareDraw(n,s),t.overlay.querySelector(".square-status").textContent="\u0421\u0436\u0438\u043C\u0430\u0435\u043C \xB7 "+Math.round(n.currentTime/n.duration*100)+"%",t.frame=requestAnimationFrame(p))};if(n.onended=()=>{c.state==="recording"&&c.stop()},await n.play(),p(),await m,squareSession!==t)return;t.blob=new Blob(u,{type:c.mimeType}),await showSquarePreview(t)}catch(s){squareSession===t&&(t.overlay.querySelector(".square-status").textContent=s.message,toast(s.message))}finally{n.pause(),n.removeAttribute("src"),n.load(),URL.revokeObjectURL(a),i?.getTracks().forEach(s=>s.stop()),await o?.close(),t.importing=!1}}async function attachSquareVideo(){const e=squareSession;if(!e?.blob)return;if(e.blob.size>8*1024*1024){toast("\u041A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u0441\u044F \u0431\u043E\u043B\u044C\u0448\u0435 8 \u041C\u0411. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u043A\u043E\u0440\u043E\u0447\u0435");return}const t={file:e.blob,thumbnail:e.thumbnail,width:480,height:480,duration:Math.min(60,e.duration),video:!0},n=e.comment;if(closeSquareRecorder(),n){await uploadCommentAttachment(n,null,t);return}if(draft.attachments.length>=10){toast("\u0414\u043E 10 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0439 \u0432 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438");return}showComposer(),uploading=!0,document.getElementById("publish-button").disabled=!0;try{const a=await uploadPrepared(t,o=>setUploadProgress(1,1,o,"\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \u043A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A"));draft.attachments.push(a),renderAttachments(),setUploadProgress(1,1,100,"\u041A\u0432\u0430\u0434\u0440\u0430\u0442\u0438\u043A \u0433\u043E\u0442\u043E\u0432")}catch(a){toast(a.message)}finally{uploading=!1,document.getElementById("publish-button")?.removeAttribute("disabled")}}document.addEventListener("pointerdown",e=>{const t=e.target.closest("button");!t||t.disabled||window.matchMedia?.("(prefers-reduced-motion: reduce)").matches||t.animate?.([{filter:"brightness(1)",opacity:1},{filter:"brightness(.88)",opacity:.8,offset:.35},{filter:"brightness(1)",opacity:1}],{duration:200,easing:"ease-out"})},{passive:!0});function layoutPhotoFrame(e){const t=e.querySelector("img"),n=e.querySelector(".photo-tags");if(!t||!n)return;const a=Number(t.getAttribute("width"))||t.naturalWidth,o=Number(t.getAttribute("height"))||t.naturalHeight,i=e.getBoundingClientRect();if(!a||!o||!i.width||!i.height)return;const s=Math.min(i.width/a,i.height/o),r=a*s,l=o*s;Object.assign(n.style,{inset:"auto",width:r+"px",height:l+"px",left:(i.width-r)/2+"px",top:(i.height-l)/2+"px"})}let photoFrameObserver=null;const observedPhotoFrames=new Set;function observePhotoFrames(e){for(const t of observedPhotoFrames)t.isConnected||(photoFrameObserver?.unobserve(t),observedPhotoFrames.delete(t));typeof ResizeObserver<"u"&&!photoFrameObserver&&(photoFrameObserver=new ResizeObserver(t=>t.forEach(n=>layoutPhotoFrame(n.target))));for(const t of e.querySelectorAll(".photo-static")){const n=t.querySelector("img");n&&!n.dataset.frameBound&&(n.dataset.frameBound="1",n.addEventListener("load",()=>layoutPhotoFrame(t)),photoFrameObserver?.observe(t),observedPhotoFrames.add(t)),layoutPhotoFrame(t)}}function replaceDraftTag(e){!tagEditor||!draft.tags[e]||(document.getElementById("tag-editor-people").innerHTML=tagEditor.people.map(t=>`<button class="people-row" onclick="changeDraftTagPerson(${e},\'${t.id}\')">${avatar(t)}<span>${esc(t.name)}</span></button>`).join(""))}function changeDraftTagPerson(e,t){const n=draft.tags[e];if(!(!n||!tagEditor?.people.some(a=>a.id===t))){if(draft.tags.some((a,o)=>o!==e&&a.mediaId===n.mediaId&&a.member===t)){toast("\u042D\u0442\u043E\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u0443\u0436\u0435 \u043E\u0442\u043C\u0435\u0447\u0435\u043D \u043D\u0430 \u0444\u043E\u0442\u043E");return}n.member!==t&&(delete n.id,delete n.comment,n.member=t,n.name=tagEditor.people.find(a=>a.id===t)?.name),refreshDraftTags()}}document.addEventListener("visibilitychange",()=>{document.visibilityState==="hidden"&&squareSession?.recorder?.state==="recording"&&squareSession.recorder.stop()});\n', "type": "application/javascript;charset=utf-8" }, "/style.css": { "body": ':root{--bg:#f5f6f8;--ink:#292d35;--muted:#9a9eaa;--line:#edf0f3;--purple:#7462df;--soft:#f0edfc}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;border:0;background:none;color:inherit;-webkit-tap-highlight-color:transparent}button:focus-visible{outline:3px solid #bcb0ff;outline-offset:3px}svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}main{max-width:600px;margin:0 auto;padding:22px 0 120px}.post{background:#fff;border:1px solid #eaecf0;border-radius:16px;margin-bottom:16px;padding:20px}.posthead{display:flex;gap:11px;align-items:center}.avatar{width:42px;height:42px;object-fit:cover;border-radius:50%;background:#eee;flex-shrink:0}.avatar.me{display:grid;place-items:center;background:#e8dfd3;color:#826e58;font-size:12px;font-weight:600}.author{font-size:12px;font-weight:600;display:flex;gap:8px;align-items:center}.degree{font-size:9px;font-weight:450;padding:4px 7px;background:#eef7f2;color:#67a789;border-radius:5px}.degree.d2{color:#9c8ac7;background:#f3effa}.degree.d3{color:#c09965;background:#fcf5e9}.meta{font-size:10px;color:#a3a8b1;line-height:1.5;margin-top:5px}.more{margin-left:auto;color:#a6aab2;font-size:24px;padding:4px 0 14px 10px;min-width:32px;min-height:44px}.posttext{font-size:13px;line-height:1.85;margin:16px 0;color:#5e6570;white-space:pre-wrap;overflow-wrap:anywhere}.photo-button{display:block;width:100%;padding:0;border-radius:10px;overflow:hidden;cursor:default}.postimage{width:100%;max-height:650px;object-fit:cover;display:block;background:#e4e9e4}.postfoot{display:flex;align-items:center;gap:22px;margin-top:12px;min-height:32px}.postfoot button{font-size:12px;color:#9299a6;display:flex;align-items:center;gap:8px;padding:5px 0;min-height:36px}.postfoot svg{width:21px;height:21px}.postfoot button.liked{color:var(--purple)}.postfoot button.liked svg{fill:#e9e3ff}.visibility{margin-left:auto;font-size:10px;color:#a9aeba;display:flex;align-items:center;gap:5px}.visibility svg{width:14px;height:14px}.comments{border-top:1px solid var(--line);padding-top:16px;margin-top:12px}.comment{font-size:12px;color:#7e8490;line-height:1.7;margin-bottom:13px;overflow-wrap:anywhere}.comment strong{color:#555c68;font-weight:550}.comment-form{display:flex;align-items:center;gap:12px}.comment-form input{width:100%;min-width:0;padding:12px;background:#f7f8fa;border:1px solid var(--line);border-radius:10px;font-size:12px;outline-color:var(--purple)}.comment-form button{color:var(--purple);min-width:40px;min-height:44px}.floating-actions{position:fixed;bottom:calc(22px + env(safe-area-inset-bottom));left:50%;width:min(600px,100%);transform:translate(-50%);display:flex;justify-content:center;align-items:center;pointer-events:none;z-index:10}.floating-actions button{pointer-events:auto;display:grid;place-items:center;box-shadow:0 6px 24px #34256923;backdrop-filter:blur(12px)}.create-button{width:58px;height:58px;border-radius:20px;background:#fffffff0;border:1px solid #e9e6f2;color:#8b81af}.create-button svg{width:29px;height:29px}.filter-button{position:absolute;right:18px;width:46px;height:46px;border-radius:16px;background:#fffffff0;border:1px solid #e9e6f2;color:#8b81af}.filter-button.filtered:after{content:"";position:absolute;right:10px;top:9px;width:6px;height:6px;background:var(--purple);border-radius:50%;border:1px solid white}.empty{padding:80px 24px;text-align:center;color:#969aaa;font-size:13px}.modalback{position:fixed;inset:0;background:#29233566;z-index:30;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(5px)}.modal{position:relative;background:#fff;width:460px;max-width:100%;max-height:85dvh;overflow:auto;border-radius:22px;padding:28px;box-shadow:0 20px 80px #29233530}.modal h2{font-size:20px;margin:0 30px 20px 0;letter-spacing:-.5px;font-weight:600}.modal p{font-size:12px;color:#9297a2;line-height:1.8}.modal .close{position:absolute;top:14px;right:14px;width:38px;height:38px;display:grid;place-items:center;color:#9599a5;font-size:26px}.modal label{font-size:12px;display:block;margin:18px 0 9px;color:#727887}.modal select{padding:12px;border:1px solid #e2e4eb;border-radius:10px;width:100%;background:#fff;color:#555;min-height:44px}.check{display:flex!important;align-items:center;gap:10px;min-height:30px}.check input{accent-color:var(--purple);width:17px;height:17px}.primary{color:#fff;background:var(--purple);border-radius:10px;padding:13px 18px;font-size:12px;display:flex;align-items:center;justify-content:center;gap:8px}.modal .primary{margin-top:24px;width:100%}.primary svg{width:17px;height:17px}.compose-input{border:0;resize:vertical;outline:none;width:100%;min-height:140px;font-size:14px;line-height:1.8;color:#555;padding:5px 0;background:#fff}.compose-input::placeholder{color:#a7aab3}.compose-tools{display:flex;align-items:center;gap:12px;border-top:1px solid var(--line);padding-top:14px;justify-content:space-between}.compose-tools button{display:flex;align-items:center;gap:7px;color:#9182be;font-size:11px;min-height:40px}.compose-tools svg{width:18px;height:18px}.attachment-preview{position:relative;margin-bottom:15px}.attachment-preview img{max-width:100%;max-height:250px;border-radius:10px;display:block}.attachment-preview button{position:absolute;top:8px;right:8px;border-radius:50%;background:#fff;width:32px;height:32px;font-size:20px}.sub{font-size:12px;color:#9a9fac;line-height:1.9}.lightbox{position:fixed;inset:0;background:#111318f5;z-index:50;display:flex;align-items:center;justify-content:center;padding:60px 15px;touch-action:pan-x pan-y pinch-zoom}.lightbox img{max-width:100%;max-height:calc(100dvh - 120px);object-fit:contain;border-radius:3px}.lightbox button{position:absolute;right:max(16px,env(safe-area-inset-right));top:calc(14px + env(safe-area-inset-top));width:44px;height:44px;background:#ffffff18;border-radius:50%;color:#fff;font-size:28px}.toast{position:fixed;bottom:calc(96px + env(safe-area-inset-bottom));left:50%;transform:translate(-50%);padding:13px 20px;border-radius:12px;background:#343044;color:#fff;z-index:60;font-size:12px;box-shadow:0 8px 30px #0002;max-width:90vw;text-align:center}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:640px){body{background:#fff}main{padding:0 0 110px;max-width:100%}.post{border:0;border-bottom:7px solid #f5f6f8;border-radius:0;margin:0;padding:18px 16px 14px}.author{font-size:12px}.posttext{font-size:13px}.photo-button{border-radius:16px;width:100%;margin-left:0}.postimage{max-height:75dvh}.postfoot{margin-top:10px}.meta{font-size:9px}.floating-actions{bottom:calc(18px + env(safe-area-inset-bottom))}.modalback{padding:0;align-items:flex-end}.modal{width:100%;max-height:92dvh;border-radius:24px 24px 0 0;padding:27px 22px calc(25px + env(safe-area-inset-bottom))}.lightbox{padding:65px 0}.lightbox img{border-radius:0}.create-button{width:56px;height:56px;border-radius:19px}.filter-button{right:20px}}.invite-button{position:absolute;left:18px;width:46px;height:46px;border-radius:16px;background:#fffffff0;border:1px solid #e9e6f2;color:#8b81af}.invite-qr{display:flex;justify-content:center;margin:22px 0}.invite-qr svg{width:min(232px,100%);height:auto;stroke:none;fill:#292d35;border-radius:12px;background:#fff}.invite-link{display:block;width:100%;border:1px solid #e6e3ef;border-radius:10px;padding:12px;background:#f9f8fc;color:#817695;font-size:11px;outline-color:var(--purple)}.invite-mode{display:flex;background:#f4f2fa;border-radius:10px;padding:4px;gap:4px;margin:16px 0}.invite-mode button{flex:1;min-height:40px;border-radius:8px;color:#9a90b2;font-size:12px}.invite-mode button.active{background:#fff;color:var(--purple);box-shadow:0 2px 5px #33225508}.invite-note{font-size:10px!important;line-height:1.6!important;margin:16px 0 0!important}@media(max-width:640px){.invite-button{left:20px}}[hidden]{display:none!important}button:disabled{opacity:.5;cursor:wait}.auth-card{max-width:380px;margin:9vh auto 0;padding:28px}.reef-wordmark{font-size:29px;font-weight:650;letter-spacing:-1px;margin-bottom:28px;color:#8b81af}.auth-card h1{font-size:22px;letter-spacing:-.6px;font-weight:550;margin-bottom:24px}.auth-card label{font-size:12px;color:#9297a4;display:block;margin:18px 0 8px}.auth-card input{width:100%;background:#fff;padding:13px;border:1px solid #e5e6ed;border-radius:10px;font-size:14px;outline-color:#b6a9ec;min-height:46px}.auth-card .primary{width:100%;margin-top:22px}.auth-card p{font-size:12px;color:#999eaa;line-height:1.8}.auth-switch{font-size:11px;color:#9a90b2;margin-top:18px;min-height:32px}.auth-footnote{text-align:center;font-size:11px!important;margin-top:20px}#auth-error{font-size:12px;color:#bb777e;line-height:1.7;margin-top:14px}.avatar.me{background:#eeeaf5;color:#9b8bbd}@media(max-width:640px){.auth-card{margin:5vh auto 0;padding:24px}.auth-card input,.comment-form input,.compose-input{font-size:16px}}.posthead button.author-button{padding:0;text-align:left;display:flex;align-items:center;gap:11px;min-width:0}.admin-badge{display:inline-grid;place-items:center;border-radius:50%;background:#8c82b5;color:#fff;width:15px;height:15px;flex-shrink:0;font-size:10px;vertical-align:middle}.admin-badge svg{width:11px;height:11px;stroke-width:2.6}.avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}.gallery-wrap{position:relative;margin:0}.gallery{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain;aspect-ratio:var(--ratio,1);border-radius:10px;background:#f0f0f3}.gallery::-webkit-scrollbar{display:none}.media-slide{flex:0 0 100%;min-width:0;width:100%;height:100%;scroll-snap-align:center;scroll-snap-stop:always;position:relative;display:grid;place-items:center}.media-slide img,.media-slide video{width:100%;height:100%;object-fit:contain;display:block;background:#f2f2f5}.media-slide video{background:#17181d}.media-slide button.photo-button{width:100%;height:100%;margin:0;border-radius:0}.gallery-counter{position:absolute;right:10px;top:10px;font-size:10px;padding:6px 9px;color:#fff;background:#3338;border-radius:12px;pointer-events:none}.gallery-dots{display:flex;gap:5px;justify-content:center;margin:9px 0 1px;align-items:center}.gallery-dots button{width:6px;height:6px;background:#d5d2e0;padding:0;border-radius:50%}.gallery-dots button.active{background:#9689c0}.media-slide .video-flag{position:absolute;left:12px;top:12px;pointer-events:none;color:#fff;font-size:11px;background:#0004;padding:5px;border-radius:6px}.postfoot .visibility{font-size:9px}.page-sentinel{height:64px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#aaa5b5}.page-sentinel button{padding:12px;color:#9587ba}.feed-error{padding:22px;text-align:center;color:#a396b6;font-size:12px}.viewbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 20px;gap:14px}.viewbar button{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:#8f82ad;background:#fff;border:1px solid #edeaf3}.viewbar h1{font-size:15px;font-weight:550;margin:0}.profile-hero{padding:24px;background:#fff;border:1px solid #eceaf1;border-radius:16px;text-align:center}.profile-avatar{width:86px;height:86px;font-size:25px!important;margin:0 auto 15px}.profile-name{display:flex;justify-content:center;gap:7px;align-items:center;font-size:21px;font-weight:550;letter-spacing:-.5px}.profile-bio{font-size:13px;line-height:1.7;color:#7e8290;margin:13px auto;white-space:pre-wrap;max-width:320px;overflow-wrap:anywhere}.profile-relation{font-size:11px;color:#a39ab2;margin:10px 0 22px;line-height:1.7}.profile-buttons{display:flex;justify-content:center;gap:10px}.profile-buttons button{padding:11px 16px;border:1px solid #e4dfed;background:#f4f1f8;color:#9180b0;border-radius:10px;font-size:12px;display:flex;gap:7px;align-items:center}.profile-buttons svg{width:17px;height:17px}.profile-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;margin-top:22px}.grid-tile{position:relative;aspect-ratio:1;background:#e9e7ee;padding:0;display:block;overflow:hidden}.grid-tile img{width:100%;height:100%;object-fit:cover;display:block}.grid-tile .grid-label{position:absolute;right:7px;top:7px;color:#fff;text-shadow:0 1px 5px #000;font-size:12px}.grid-text{padding:15px;display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;line-height:1.6;color:#9386ac;white-space:pre-wrap;overflow:hidden;background:#f1edf5}.profile-button,.inbox-button{position:absolute;width:42px;height:42px;border-radius:15px;background:#fffffff0;border:1px solid #e9e6f2;color:#8b81af}.profile-button{right:85px}.inbox-button{left:85px}.inbox-button.unread:after{content:"";position:absolute;right:8px;top:8px;width:6px;height:6px;background:#9684ba;border:1px solid white;border-radius:50%}.modal textarea.bio-input,.modal input.profile-name-input{width:100%;border:1px solid #e7e3ee;border-radius:10px;padding:12px;background:#fff;font:inherit;font-size:14px;resize:vertical;color:#777}.bio-input{min-height:90px}.avatar-edit{margin:0 auto;display:block;width:82px;height:82px;position:relative;border-radius:50%;padding:0;overflow:hidden;background:#eee8f3}.avatar-edit img{width:100%;height:100%;object-fit:cover}.avatar-edit span{display:grid;place-items:center;width:100%;height:100%;color:#aa99bd}.composer-thumbs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:thin;padding-bottom:8px}.composer-thumb{position:relative;min-width:86px;width:86px;height:86px;border-radius:10px;overflow:hidden;background:#eee8f2;display:grid;place-items:center;color:#ac9bb9}.composer-thumb img{width:100%;height:100%;object-fit:cover}.composer-thumb button{position:absolute;top:3px;right:3px;width:24px;height:24px;background:#fffd;border-radius:50%;font-size:18px}.composer-thumb .video-mini{position:absolute;bottom:4px;left:5px;color:#fff;text-shadow:0 1px 4px #000}.upload-status{font-size:11px;color:#a18bb9;margin:8px 0;min-height:16px}.compose-tools{gap:15px}.compose-tools button{font-size:10px}.compose-tools .privacy-tool{margin-left:auto}.global-check{display:flex!important;align-items:center;gap:9px;font-size:12px!important;margin:15px 0!important}.global-check input{accent-color:#9583b7}.camera-preview{width:100%;max-height:60dvh;border-radius:12px;background:#1d1c22;object-fit:cover}.camera-controls{display:flex;justify-content:center;gap:26px;align-items:center;margin-top:20px}.camera-controls button{border-radius:50%;width:46px;height:46px;display:grid;place-items:center;background:#eeebf4;color:#9280ad}.camera-controls .shutter{width:64px;height:64px;border:4px solid #ded5e8;background:#f7f4fa;box-shadow:inset 0 0 0 3px #fff}.camera-note{text-align:center;font-size:12px;color:#a191b1}.chat-row{display:flex;align-items:center;gap:12px;background:#fff;padding:18px;border-bottom:1px solid #f0edf4;width:100%;text-align:left}.chat-row .chat-summary{min-width:0;flex:1}.chat-row strong{font-size:13px;font-weight:550;display:block}.chat-row p{font-size:11px;color:#aaa0b7;margin:7px 0 0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.unread-dot{width:8px;height:8px;border-radius:50%;background:#a293bb}.chat-thread{display:flex;flex-direction:column;gap:12px;padding:10px 0 90px}.bubble{align-self:flex-start;max-width:85%;border-radius:15px 15px 15px 4px;padding:12px 15px;font-size:13px;line-height:1.6;background:#fff;color:#787080;white-space:pre-wrap;overflow-wrap:anywhere}.bubble.own{align-self:flex-end;background:#ede7f3;border-radius:15px 15px 4px;color:#8a789b}.bubble small{font-size:9px;color:#b3a6bd;display:block;text-align:right;margin-top:5px}.chat-input{position:fixed;bottom:calc(15px + env(safe-area-inset-bottom));left:50%;transform:translate(-50%);width:min(568px,calc(100% - 30px));display:flex;gap:10px;background:#fffffff5;backdrop-filter:blur(10px);padding:9px;border:1px solid #e8e1ee;border-radius:16px;z-index:12}.chat-input input{border:0;background:transparent;outline:0;min-width:0;flex:1;padding:8px;font-size:16px;color:#8a8095}.chat-input button{color:#9981b7;width:40px}.detail-modal{padding:0!important;max-width:600px;width:100%;border-radius:18px}.detail-modal>.close{z-index:4;top:6px;right:5px;background:#fff9}.detail-modal>h2{display:none}.detail-modal .post{border:0;margin:0;border-radius:0;content-visibility:visible;padding-top:43px}.lightbox video{max-width:100%;max-height:calc(100dvh - 120px)}.lightbox .lightbox-nav{position:absolute;top:50%;right:12px;width:40px;height:40px;font-size:24px}.lightbox .lightbox-prev{left:12px;right:auto}.lightbox-count{position:absolute;bottom:22px;color:#fffa;font-size:12px}.lightbox>.close-photo{top:calc(14px + env(safe-area-inset-top));right:16px}.media-slide img[loading]{min-height:0}.post .author .author-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}.post.updated:after{content:""}@media(max-width:640px){.gallery-wrap{margin-left:0;margin-right:0}.gallery{border-radius:0}.gallery-dots{margin:10px 0 0}.profile-hero{border:0;padding:20px 18px}.viewbar{padding:14px 16px 10px}.profile-grid{margin-top:14px;gap:2px}.profile-hero .profile-name{font-size:22px}.chat-thread{padding:10px 16px 100px}.detail-modal{border-radius:24px 24px 0 0}.detail-modal:before{display:none}.post .author .author-name{max-width:160px}.profile-button{right:79px}.inbox-button{left:79px}.compose-tools button{font-size:11px}.profile-grid+.page-sentinel{margin-bottom:50px}.avatar-edit,.profile-avatar{flex-shrink:0}.camera-preview{max-height:55dvh}.lightbox video{width:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}:root{--surface:#fff;--surface-soft:#f4f1f8;--bg:#f5f6f8;--ink:#292d35;--text-soft:#6f697b;--muted:#96909f;--line:#e9e4ef;--accent:#9280ae;--purple:#83719e;--action:#83719e;--on-action:#fff;--field:#f6f4f8}.primary,.auth-card .primary,.modal .primary{background:var(--action,#83719e);color:var(--on-action,#fff);opacity:1;min-height:44px}.primary:disabled{opacity:.65;color:var(--on-action);background:var(--action)}.gallery{aspect-ratio:1!important;background:var(--field)}.media-slide img{object-fit:cover;aspect-ratio:1}.media-slide video{object-fit:contain}.media-slide .photo-static{width:100%;height:100%;overflow:hidden}.media-slide .photo-static img{width:100%;height:100%;object-fit:cover;cursor:default}.floating-actions button,.chat-input{backdrop-filter:none}.modalback{backdrop-filter:none;background:#17131e88}.theme-button,.notice-profile-button,.admin-profile-button{border:1px solid var(--line);color:var(--accent);background:var(--surface-soft);border-radius:10px;font-size:12px;min-height:42px;padding:10px 15px;display:inline-flex;gap:8px;align-items:center;justify-content:center}.profile-tools{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-top:12px}.profile-tools svg{width:17px;height:17px}.notification-count{display:inline-flex;border-radius:10px;min-width:17px;padding:1px 5px;font-size:10px;background:var(--accent);color:#fff;justify-content:center}.notice-list{display:grid;gap:2px}.notice-row{display:flex;align-items:center;gap:12px;width:100%;padding:16px;text-align:left;background:var(--surface);border-bottom:1px solid var(--line)}.notice-row.unseen{background:var(--surface-soft)}.notice-copy{font-size:12px;line-height:1.65;color:var(--text-soft)}.notice-copy strong{color:var(--ink);font-weight:550}.notice-copy small{font-size:10px;color:var(--muted);display:block;margin-top:5px}.comment-content{display:flex;align-items:flex-start;gap:12px}.comment-like{display:flex;gap:4px;align-items:center;flex-shrink:0;color:var(--muted);font-size:10px;min-width:34px;min-height:34px;padding:3px}.comment-like svg{width:16px;height:16px}.comment-like.liked{color:var(--accent)}.comment-like.liked svg{fill:var(--surface-soft)}.friend-celebration{position:fixed;top:calc(20px + env(safe-area-inset-top));left:50%;transform:translate(-50%);width:min(350px,calc(100% - 32px));padding:20px 16px 15px;background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 10px 35px #20162b1a;z-index:90;pointer-events:none;animation:friend-enter .3s ease-out,friend-exit .3s ease-in 3.4s forwards}.friend-stage{height:64px;position:relative;display:flex;align-items:center;justify-content:space-between;max-width:260px;margin:auto}.friend-stage .avatar{width:50px;height:50px;z-index:2;border:3px solid var(--surface)}.friend-left{animation:friend-left 1.1s ease-in-out both}.friend-right{animation:friend-right 1.1s ease-in-out both}.friend-rings{position:absolute;left:50%;top:50%;width:90px;height:50px;transform:translate(-50%,-50%)}.friend-ring{position:absolute;top:6px;width:38px;height:38px;border:6px solid var(--accent);border-radius:50%;left:5px;animation:reef-left 1.2s ease-in-out both}.friend-ring.second{left:44px;border-color:#bd9fd2;animation:reef-right 1.2s ease-in-out both}.friend-caption{text-align:center;font-size:12px;color:var(--text-soft);margin-top:14px;line-height:1.5}.friend-caption strong{color:var(--ink);font-weight:550}.admin-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 16px 20px}.admin-stat{padding:15px 8px;text-align:center;background:var(--surface);border:1px solid var(--line);border-radius:12px}.admin-stat strong{font-size:21px;font-weight:550;display:block}.admin-stat small{display:block;font-size:10px;color:var(--muted);margin-top:5px}.admin-search{margin:0 16px 16px;display:flex;gap:8px}.admin-search input{flex:1;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--ink)}.admin-search button{border-radius:10px;background:var(--surface-soft);color:var(--accent);padding:10px 14px}.admin-user{background:var(--surface);padding:18px;margin:0 16px 12px;border:1px solid var(--line);border-radius:13px}.admin-user strong{font-size:13px}.admin-user p{color:var(--muted);font-size:11px;margin:7px 0;overflow-wrap:anywhere}.admin-user-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.admin-user-actions button{background:var(--surface-soft);color:var(--accent);font-size:11px;padding:9px 11px;border:1px solid var(--line);border-radius:8px}.profile-button.has-notices:after{content:"";position:absolute;right:7px;top:7px;width:6px;height:6px;background:var(--accent);border:1px solid var(--surface);border-radius:50%}@keyframes friend-enter{0%{opacity:0;translate:0 -15px}to{opacity:1;translate:0 0}}@keyframes friend-exit{to{opacity:0;translate:0 -12px}}@keyframes reef-left{0%{transform:translate(-48px) scale(.4);opacity:0}35%{opacity:1}to{transform:translate(13px)}}@keyframes reef-right{0%{transform:translate(48px) scale(.4);opacity:0}35%{opacity:1}to{transform:translate(-6px) translateY(7px)}}@keyframes friend-left{0%{transform:translate(-15px);opacity:0}to{transform:translate(0);opacity:1}}@keyframes friend-right{0%{transform:translate(15px);opacity:0}to{transform:translate(0);opacity:1}}:root[data-theme=dark]{color-scheme:dark;--surface:#24212a;--surface-soft:#302938;--bg:#19171d;--ink:#eee8f3;--text-soft:#c2b6cc;--muted:#aa9db6;--line:#3b3244;--accent:#baa3d1;--purple:#baa3d1;--action:#a78bbc;--on-action:#18121e;--field:#2c2633}body{background:var(--bg);color:var(--ink)}.post,.modal,.profile-hero,.chat-row,.viewbar button{background:var(--surface);border-color:var(--line)}.posttext,.profile-bio,.bubble,.comment{color:var(--text-soft)}.meta,.sub,.visibility,.profile-relation,.chat-row p,.auth-card p{color:var(--muted)}.author,.profile-name,.comment strong,.chat-row strong{color:var(--ink)}.compose-input,.auth-card input,.modal select,.modal input.profile-name-input,.modal textarea.bio-input{background:var(--surface);color:var(--ink);border-color:var(--line)}.comment-form input,.chat-input,.admin-search input{background:var(--field);color:var(--ink);border-color:var(--line)}.floating-actions button,.viewbar button{background:var(--surface);border:1px solid var(--line);color:var(--accent)}.profile-buttons button,.invite-mode,.compose-tools,.avatar.me{background:var(--surface-soft);color:var(--accent);border-color:var(--line)}.compose-tools{background:transparent}.invite-mode button.active{background:var(--surface);color:var(--accent)}.invite-link{background:var(--field);color:var(--text-soft);border-color:var(--line)}.bubble{background:var(--surface)}.bubble.own{background:var(--surface-soft);color:var(--text-soft)}.chat-input input{color:var(--ink)}.grid-text{background:var(--surface-soft);color:var(--text-soft)}.profile-buttons button{border-color:var(--line)}.theme-button,.notice-profile-button,.admin-profile-button{background:var(--surface-soft);color:var(--accent)}[data-theme=dark] .degree{background:#263d34;color:#b0d6bd}[data-theme=dark] .degree.d2{background:#3b304a;color:#c7addf}[data-theme=dark] .degree.d3{background:#453829;color:#dfc49f}[data-theme=dark] .detail-modal>.close{background:#302938ee;color:var(--ink)}[data-theme=dark] .modalback{background:#070509b3}[data-theme=dark] .gallery-dots button{background:#594b66}[data-theme=dark] .gallery-dots button.active{background:var(--accent)}[data-theme=dark] .admin-badge{background:var(--accent);color:#211729}@media(max-width:640px){body{background:var(--surface)}.post{border-bottom-color:var(--bg)}.gallery{aspect-ratio:1!important}.floating-actions button{box-shadow:0 3px 15px #1c132422}.chat-input{backdrop-filter:none}}@media(prefers-reduced-motion:reduce){.friend-celebration,.friend-ring,.friend-stage .avatar{animation:none}.friend-ring{transform:translate(13px)}.friend-ring.second{transform:translate(-6px,7px)}}main{padding-bottom:calc(82px + env(safe-area-inset-bottom))}.page-sentinel:empty{display:none;height:0;margin:0}#feed-list>.post:last-child{margin-bottom:0}.own-degree{background:var(--surface-soft);color:var(--accent)}.avatar-open{display:block;margin:0 auto;padding:0;border:0;background:transparent;border-radius:50%;cursor:pointer}.avatar-open .profile-avatar{margin-bottom:15px}.profile-buttons button[onclick="editProfile()"],.change-avatar-button{background:var(--action);color:var(--on-action);border:1px solid var(--action);font-weight:600;opacity:1}.change-avatar-button{display:block;margin:12px auto 18px;padding:10px 17px;border-radius:10px;min-height:40px;font-size:12px}.avatar-edit{border:2px solid var(--accent)}.avatar-edit span{color:var(--accent)}.post{position:relative}.photo-static{touch-action:pan-x pan-y}.double-like-heart{position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);pointer-events:none;z-index:3;animation:double-heart .7s ease-out forwards;filter:drop-shadow(0 2px 7px #0004)}.double-like-heart svg{width:76px;height:76px;fill:#fff;stroke:#fff;stroke-width:1.4}.avatar-lightbox img{max-width:100%;max-height:calc(100dvh - 100px);object-fit:contain}@keyframes double-heart{0%{opacity:0;scale:.5}20%{opacity:1;scale:1.1}65%{opacity:1;scale:1}to{opacity:0;scale:1.15}}@media(prefers-reduced-motion:reduce){.double-like-heart{animation:none;opacity:.8}}.requests-profile-button{border:1px solid var(--line);color:var(--accent);background:var(--surface-soft);border-radius:10px;font-size:12px;min-height:42px;padding:10px 15px;display:inline-flex;gap:8px;align-items:center;justify-content:center}.requests-profile-button svg{width:17px;height:17px}.profile-buttons{flex-wrap:wrap}.profile-buttons .accept-friend,.friend-request-actions .accept-friend{background:var(--action);color:var(--on-action);border-color:var(--action)}.notice-row{display:block;padding:0}.notice-main{display:flex;align-items:center;text-align:left;width:100%;gap:12px;padding:16px;color:var(--ink)}.friend-request-actions{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 14px}.friend-request-actions button{padding:10px 13px;border:1px solid var(--line);border-radius:9px;background:var(--surface-soft);color:var(--accent);font-size:12px;min-height:40px}.request-section{padding:0 16px}.request-section h2{font-size:13px;color:var(--muted);font-weight:500;margin:20px 0 12px}.request-row{background:var(--surface);border:1px solid var(--line);border-radius:13px;margin-bottom:12px}.request-person{display:flex;align-items:center;gap:11px;width:100%;padding:16px;text-align:left;color:var(--ink)}.request-person strong{font-size:13px;font-weight:550}.request-empty{font-size:12px;color:var(--muted);padding:12px 0 20px}.profile-buttons .remove-friend-button{color:var(--text-soft);background:var(--surface-soft)}.telegram-badge{display:inline-grid;place-items:center;flex-shrink:0;width:16px;height:16px;border-radius:50%;background:#4b9bc9;color:#fff}.telegram-badge svg{width:11px;height:11px;stroke-width:2.5}.staff-badge.admin-badge{width:21px;height:21px;display:inline-grid;place-items:center;border-radius:6px;background:var(--surface-soft);color:var(--accent);cursor:pointer;flex-shrink:0}.staff-badge.admin-badge svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8}.staff-badge:focus-visible{outline:2px solid var(--accent)}.account-menu{display:grid;gap:6px}.account-menu>button{display:flex;align-items:center;gap:13px;min-height:49px;border-radius:11px;padding:13px;background:var(--surface-soft);color:var(--ink);text-align:left;font-size:13px}.account-menu>button>svg{color:var(--accent);width:20px;height:20px}.account-menu>button>small{margin-left:auto;color:var(--accent)}.top-notice{position:fixed;top:calc(16px + env(safe-area-inset-top));left:50%;transform:translate(-50%);width:min(400px,calc(100% - 24px));background:var(--surface);color:var(--ink);border:1px solid var(--line);box-shadow:0 7px 24px #15101c24;border-radius:17px;z-index:85;display:flex;align-items:center;animation:top-notice-enter .25s ease-out}.top-notice-open{display:flex;align-items:center;gap:12px;padding:16px;text-align:left;flex:1;min-width:0}.top-notice-open span{min-width:0}.top-notice-open strong{font-size:12px;font-weight:550}.top-notice-open small{display:block;font-size:11px;line-height:1.6;color:var(--text-soft);margin-top:3px}.top-notice-close{width:36px;height:44px;font-size:22px;color:var(--muted);flex-shrink:0;margin-right:5px}.chat-thread{padding-bottom:180px}.profile-tools:empty{display:none}@keyframes top-notice-enter{0%{opacity:0;translate:0 -15px}to{opacity:1;translate:0 0}}@media(prefers-reduced-motion:reduce){.top-notice{animation:none}}.custom-badge{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;border:1px solid var(--badge-color);color:var(--badge-color);background:var(--surface);vertical-align:middle;flex-shrink:0;overflow:hidden;cursor:pointer}.custom-badge svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.8}.custom-badge>span{font-size:15px;line-height:1}.custom-badge img{width:100%;height:100%;object-fit:cover}.custom-badge:focus-visible{outline:2px solid var(--badge-color);outline-offset:3px}.assigned-badges{display:grid;gap:10px}.assigned-badge-row{display:flex;align-items:center;gap:10px;padding:10px;background:var(--surface-soft);border-radius:10px;color:var(--ink);font-size:12px}.assigned-badge-row>span:nth-child(2){flex:1;overflow-wrap:anywhere}.assigned-badge-row>button{color:var(--accent);padding:7px}.badge-form-title{font-size:14px;font-weight:550;margin:24px 0 8px}.badge-symbols{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:16px}.badge-symbols button{display:grid;place-items:center;min-height:44px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--accent)}.badge-symbols button.selected{background:var(--surface-soft);border-color:var(--accent)}.badge-color-label{display:flex!important;align-items:center;gap:14px}.badge-color-label input{width:50px;height:35px;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:3px}.badge-preview{display:flex;gap:10px;align-items:center;padding:13px;border:1px solid var(--line);border-radius:11px;margin-top:15px;font-size:13px;color:var(--ink);overflow-wrap:anywhere}.badge-info-icon{display:flex;justify-content:center;margin:24px}.badge-info-icon .custom-badge{width:55px;height:55px;border-radius:13px}.badge-info-icon .custom-badge svg{width:37px;height:37px}.badge-info-icon .custom-badge>span{font-size:34px}.profile-name{flex-wrap:wrap}.post .author{gap:6px;flex-wrap:wrap}.post .author .author-name{max-width:160px}.profile-notifications{min-width:43px;position:relative}.profile-notifications .notification-count{position:absolute;right:-4px;top:-5px}.profile-presence{display:flex;justify-content:center;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin:10px 0}.presence-dot{width:6px;height:6px;border-radius:50%;background:#a499ac}.presence-dot.online{background:#62ac85}.friends-count{padding:7px 14px;margin:0 0 16px;border:1px solid var(--line);border-radius:20px;font-size:12px;color:var(--accent);background:var(--surface-soft)}.friend-list-row{display:flex;width:100%;align-items:center;gap:12px;padding:17px;background:var(--surface);border-bottom:1px solid var(--line);text-align:left}.friend-list-row>span{flex:1}.friend-list-row strong{font-size:13px;font-weight:550}.friend-list-row small{display:block;font-size:10px;color:var(--muted);margin-top:5px}.friend-list-row>svg{width:17px;color:var(--muted)}.comment-copy>.custom-badge,.comment-copy>.staff-badge,.comment-copy>.telegram-badge{margin-left:5px;vertical-align:middle}.comment-copy>.custom-badge{width:18px;height:18px}.comment-copy>.custom-badge svg{width:13px;height:13px}.comments{animation:comments-enter .2s ease-out}.comments-expanded{color:var(--accent)!important}.loading-comments svg{animation:comments-loading .8s ease-in-out infinite alternate}.comments-modal{max-height:78dvh}.comments-modal .comments{border-top:0;padding-top:0}.comments-modal .comment-form{position:sticky;bottom:0;background:var(--surface);padding-top:10px}.comments-sheet{min-height:140px}.feed-mode-option{display:block;width:100%;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);text-align:left;margin-top:12px}.feed-mode-option strong{display:block;font-size:13px;font-weight:550;color:var(--ink)}.feed-mode-option span{display:block;font-size:11px;color:var(--muted);line-height:1.8;margin-top:7px}.feed-mode-option.selected{background:var(--surface-soft);border-color:var(--accent)}.photo-static{cursor:zoom-in}.photo-zoom-viewport{position:absolute;inset:60px 0 90px;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;user-select:none}.photo-zoom-viewport img{max-width:100%;max-height:100%;object-fit:contain;transform-origin:center;will-change:transform;pointer-events:none}.photo-zoom-controls{position:absolute;bottom:22px;left:50%;transform:translate(-50%);display:flex;align-items:center;gap:8px;z-index:5}.photo-zoom-controls button{position:static;min-width:40px;width:auto;height:40px;border-radius:12px;background:#ffffff20;color:#fff;padding:6px 12px;font-size:16px}.photo-lightbox>.close-photo{z-index:6}.photo-lightbox .lightbox-count{bottom:70px}.screen-feed{scroll-snap-type:y mandatory;scroll-padding-top:0}.screen-feed main{padding:0!important;max-width:700px}.screen-feed #feed-list>.post{scroll-snap-align:start;scroll-snap-stop:always;height:100dvh;min-height:100dvh;margin:0;border-radius:0;border:0;display:flex;flex-direction:column;gap:10px;padding:calc(32px + env(safe-area-inset-top)) 16px calc(82px + env(safe-area-inset-bottom));overflow:hidden}.screen-feed .posthead,.screen-feed .postfoot{flex-shrink:0}.screen-feed .posttext{flex-shrink:0;max-height:20dvh;overflow:auto;margin:0;font-size:12px;line-height:1.6}.screen-feed .gallery-wrap{flex:1;min-height:0;display:flex;flex-direction:column;margin:0}.screen-feed .gallery{flex:1;min-height:0;aspect-ratio:auto!important;height:100%;border-radius:0}.screen-feed .gallery-dots{flex-shrink:0;margin:8px 0 0}.screen-feed .postfoot{margin-top:0}.screen-feed #feed-list>.post>.comments-slot{display:none}.screen-feed .text-only .posttext{flex:1;display:flex;align-items:center;justify-content:center;max-height:none;font-size:16px;line-height:1.65;text-align:center;padding:20px;white-space:pre-wrap}.screen-feed .text-only .postfoot{margin-top:auto}.screen-feed #page-sentinel[hidden]{display:none}@keyframes comments-enter{0%{opacity:.3;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}@keyframes comments-loading{0%{opacity:.3}to{opacity:1}}@media(prefers-reduced-motion:reduce){.comments,.loading-comments svg{animation:none}.screen-feed{scroll-behavior:auto}.photo-zoom-viewport img{will-change:auto}}.muted-authors{margin-top:20px;border:1px solid var(--line);border-radius:12px}.muted-authors summary{padding:14px;cursor:pointer;font-size:12px;color:var(--text-soft)}.muted-authors summary span{float:right;color:var(--muted)}.muted-authors-list{padding:0 14px 10px;max-height:35dvh;overflow:auto}.modal{transition:transform .18s ease-out;overscroll-behavior-y:contain}.sheet-handle{display:none}@media(max-width:640px){.sheet-handle{display:flex;align-items:center;justify-content:center;width:90px;height:26px;margin:-23px auto 12px;touch-action:none;cursor:grab}.sheet-handle span{width:34px;height:4px;border-radius:4px;background:var(--muted);opacity:.4}.sheet-dragging{transition:none}.sheet-dragging .sheet-handle{cursor:grabbing}}@media(prefers-reduced-motion:reduce){.modal{transition:none}}.post .posttext,.screen-feed .post .posttext{line-height:1.5;white-space:normal}.posttext>p,.modal .posttext>p{margin:0;font:inherit;color:inherit;line-height:inherit;white-space:pre-wrap;flex-shrink:0}.posttext>p+p{margin-top:.8em}.screen-feed .text-only .posttext{flex-direction:column}.gallery,.screen-feed .gallery,.photo-button,.media-slide,.media-slide img,.postimage,.grid-tile,.grid-tile img,.composer-thumbs img,.attachment-preview img,.lightbox img{border-radius:16px}.photo-static{border-radius:16px;overflow:hidden}.postfoot button[data-like],.comment-like{transition:color .16s ease}.postfoot button[data-like]:active,.comment-like:active,.postfoot button.liked,.comment-like.liked{color:var(--purple)}.postfoot button.liked svg,.comment-like.liked svg{fill:currentColor;stroke:currentColor}.postfoot button[data-like] svg,.comment-like svg{transform-origin:center}@media(prefers-reduced-motion:reduce){.postfoot button[data-like],.comment-like{transition:none}}main:has(>#feed-list){padding-bottom:0}#feed-list{padding-bottom:calc(112px + env(safe-area-inset-bottom))}.screen-feed #feed-list>.post{padding-bottom:calc(112px + env(safe-area-inset-bottom))}.crop-overlay{position:fixed;inset:0;z-index:80;background:#17131ee6;display:grid;place-items:center;padding:16px;overscroll-behavior:contain;overflow:auto}.crop-dialog{width:min(460px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:var(--surface);border-radius:22px;padding:20px;color:var(--ink)}.crop-dialog h2{font-size:18px;margin:0 0 10px}.crop-dialog p{font-size:12px;line-height:1.5;color:var(--muted)}.crop-stage{position:relative;width:min(100%,48dvh);aspect-ratio:1;margin:16px auto;touch-action:none;cursor:move;border-radius:16px;overflow:hidden;background:#111}.crop-stage canvas{display:block;width:100%;height:100%}.crop-frame{position:absolute;inset:1px;border:2px solid white;border-radius:15px;pointer-events:none;background:linear-gradient(to right,transparent 33%,#ffffff55 33%,#ffffff55 33.3%,transparent 33.3%,transparent 66.6%,#ffffff55 66.6%,#ffffff55 66.9%,transparent 66.9%),linear-gradient(to bottom,transparent 33%,#ffffff55 33%,#ffffff55 33.3%,transparent 33.3%,transparent 66.6%,#ffffff55 66.6%,#ffffff55 66.9%,transparent 66.9%)}.crop-scale{display:flex;align-items:center;gap:14px;font-size:12px}.crop-scale input{min-width:0;flex:1;accent-color:var(--action);min-height:44px}.crop-actions{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-top:14px}.crop-actions .auth-switch{margin:0}.crop-actions .primary{min-width:120px}:root{--post-text:#49424f}:root[data-theme=dark]{--post-text:#e2dae9}.post .posttext,.screen-feed .post .posttext{font-size:15px;line-height:1.5;color:var(--post-text)}.screen-feed .text-only .posttext{min-height:0;flex:1 1 0;justify-content:flex-start;overflow-y:auto}.screen-feed .text-only .posttext>p{width:100%}.screen-feed .text-only .posttext>p:first-child{margin-top:auto}.screen-feed .text-only .posttext>p:last-child{margin-bottom:auto}.read-more{display:block;color:var(--accent);font-size:13px;font-weight:600;padding:9px 0;min-height:40px;flex-shrink:0;background:var(--surface)}.screen-feed .read-more{position:static;width:100%;text-align:inherit;margin-top:8px}.invite-quota{display:flex;align-items:center;gap:14px;padding:18px;margin:18px 0;background:var(--surface-soft);border:1px solid var(--line);border-radius:16px}.invite-quota>strong{font-size:30px;color:var(--ink);letter-spacing:-1px}.invite-quota strong span{font-size:19px;color:var(--muted);font-weight:400}.invite-quota>span{font-size:12px;color:var(--text-soft);max-width:90px;line-height:1.5}[data-copy-invite]{transition:background .2s ease,transform .2s ease}[data-copy-invite].copy-done{opacity:1;cursor:default;background:var(--accent)}.copy-done span{animation:copy-confirm .25s ease-out}@keyframes copy-confirm{0%{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}.filters-modal .filter-intro{margin-bottom:20px}.depth-cards{display:grid;gap:10px}.modal .depth-card{display:flex;gap:12px;align-items:center;padding:15px;margin:0;border:1px solid var(--line);border-radius:15px;cursor:pointer;background:var(--surface)}.depth-card:has(input:checked){background:var(--surface-soft);border-color:var(--accent)}.depth-card input{position:absolute;opacity:0;width:1px;height:1px}.depth-card:focus-within{outline:2px solid var(--accent);outline-offset:2px}.depth-card-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--field);color:var(--accent)}.depth-card strong{display:block;font-size:13px;color:var(--ink);font-weight:600}.depth-card small{display:block;font-size:11px;margin-top:4px;line-height:1.5;color:var(--muted)}.depth-radio{margin-left:auto;width:18px;height:18px;border:1px solid var(--line);border-radius:50%;flex-shrink:0}.depth-card:has(input:checked) .depth-radio{border:5px solid var(--accent)}.invisible-setting{display:flex!important;align-items:center;justify-content:space-between;gap:12px;padding:17px 0!important;border-bottom:1px solid var(--line);margin:0!important}.invisible-setting>span{display:grid;grid-template-columns:22px 1fr;gap:6px 12px;color:var(--ink)}.invisible-setting small{grid-column:2;font-size:10px;color:var(--muted);line-height:1.5}.invisible-setting input{width:36px;height:22px;accent-color:var(--accent)}.poll-editor{padding:15px;background:var(--surface-soft);border:1px solid var(--line);border-radius:14px;margin:12px 0}.poll-editor-title{display:flex;justify-content:space-between;align-items:center;font-weight:600}.poll-editor input{width:100%;margin-top:8px;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);font-size:16px}.poll-editor-tools{display:flex;justify-content:space-between;margin-top:10px;font-size:11px;color:var(--accent)}.post-poll{padding:12px 0;flex-shrink:0;max-height:48dvh;overflow:auto}.post-poll>small{display:block;font-size:10px;color:var(--muted);margin:6px 0 10px}.poll-option{position:relative;display:flex;align-items:center;gap:8px;width:100%;border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:8px;overflow:hidden;text-align:left;min-height:44px}.poll-option>span:not(.poll-bar){position:relative;flex:1;font-size:13px;overflow-wrap:anywhere}.poll-option strong{position:relative;font-size:12px;color:var(--accent)}.poll-bar{position:absolute;left:0;top:0;bottom:0;background:var(--surface-soft);transition:width .25s ease}.poll-option.selected{border-color:var(--accent)}.poll-option.selected .poll-bar{background:var(--soft)}[data-theme=dark] .poll-option.selected .poll-bar{background:#48384f}.chat-thread{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px 16px 170px}.chat-thread .bubble{max-width:85%;margin:0;padding:11px 13px 7px;border-radius:17px 17px 17px 5px;background:var(--surface);border:1px solid var(--line);box-shadow:0 2px 6px #00000005;white-space:normal}.chat-thread .bubble.own{align-self:flex-end;background:var(--surface-soft);border-radius:17px 17px 5px}.message-text{white-space:pre-wrap;font-size:14px;line-height:1.5;overflow-wrap:anywhere}.message-meta{display:flex;align-items:center;justify-content:flex-end;gap:13px;margin-top:4px}.message-meta time{font-size:9px;color:var(--muted)}.message-like{display:flex;align-items:center;gap:4px;color:var(--muted);padding:4px;min-width:28px;min-height:28px}.message-like svg{width:15px;height:15px}.message-like span{font-size:10px}.message-like.liked{color:var(--purple)}.message-like.liked svg{fill:currentColor}@media(prefers-reduced-motion:reduce){.copy-done span{animation:none}.poll-bar,[data-copy-invite]{transition:none}}.screen-feed #feed-list>.post .posttext{text-align:left}.postfoot button[data-like],.postfoot button[data-comments]{min-height:44px;overflow:visible;align-items:center}.postfoot button[data-like] svg,.postfoot button[data-comments] svg{display:block;width:22px;height:22px;flex:0 0 22px;overflow:visible;stroke-width:1.8}.theme-transition body,.theme-transition .post,.theme-transition .modal,.theme-transition .modalback,.theme-transition .profile-hero,.theme-transition .chat-row,.theme-transition .bubble,.theme-transition .viewbar button,.theme-transition .floating-actions button,.theme-transition .account-menu button,.theme-transition input,.theme-transition textarea,.theme-transition select,.theme-transition .depth-card,.theme-transition .muted-authors,.theme-transition .poll-option,.theme-transition .read-more,.theme-transition .invite-quota{transition:background-color .45s ease,color .45s ease,border-color .45s ease,box-shadow .45s ease}.theme-transition .posttext,.theme-transition .posttext p,.theme-transition .profile-bio,.theme-transition .message-text,.theme-transition .comment,.theme-transition .account-menu span{transition:color .45s ease}@media(prefers-reduced-motion:reduce){.theme-transition *{transition:none!important}}.modal-heading{display:flex;align-items:center;gap:10px;margin:0 32px 20px 0}.modal .modal-heading h2{margin:0;min-width:0}.modal-back{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;margin-left:-6px;border-radius:11px;color:var(--accent);background:var(--surface-soft)}.modal-back svg{width:19px;height:19px}.modalback:has(.invite-modal),.modalback:has(.filters-modal){align-items:flex-end;padding:0;animation:sheet-backdrop-in .22s ease-out}.invite-modal,.filters-modal{width:min(460px,100%);border-radius:24px 24px 0 0;animation:sheet-rise-in .32s cubic-bezier(.22,.8,.25,1)}.invite-modal.sheet-dragging,.filters-modal.sheet-dragging{animation:none}@keyframes sheet-rise-in{0%{transform:translateY(100%);opacity:.65}to{transform:translateY(0);opacity:1}}@keyframes sheet-backdrop-in{0%{opacity:0}to{opacity:1}}.push-hero{text-align:center;padding:8px 5px 10px}.push-hero-icon{width:68px;height:68px;display:grid;place-items:center;margin:0 auto 15px;border-radius:23px;background:var(--surface-soft);color:var(--accent)}.push-hero-icon svg{width:31px;height:31px;stroke-width:1.5}.push-state{display:inline-block;font-size:10px;padding:5px 10px;border-radius:20px;background:var(--field);color:var(--muted)}.push-state.enabled{background:var(--surface-soft);color:var(--accent)}.push-hero h3{font-size:20px;font-weight:600;letter-spacing:-.4px;margin:16px 0 10px}.modal .push-hero p{font-size:12px;line-height:1.6;color:var(--text-soft);max-width:310px;margin:0 auto}.push-events{display:grid;gap:13px;padding:18px;border:1px solid var(--line);border-radius:16px;background:var(--surface-soft);margin:14px 0 4px}.push-events>span{display:flex;align-items:center;gap:11px;font-size:12px;color:var(--text-soft)}.push-events svg{width:19px;height:19px;color:var(--accent)}.push-test-button{display:block;width:100%;min-height:44px;margin-top:12px;border:1px solid var(--line);border-radius:12px;font-size:12px;color:var(--accent)}.push-disable-button{display:block;min-height:40px;margin:7px auto;font-size:11px;color:var(--muted)}.push-help-card{margin-top:18px;border:1px solid var(--line);border-radius:13px;padding:14px;font-size:11px;color:var(--muted);line-height:1.6}.push-help-card summary{cursor:pointer;color:var(--text-soft)}.modal .push-help-card p{font-size:11px;line-height:1.6;margin:10px 0 0;color:var(--muted)}@media(prefers-reduced-motion:reduce){.invite-modal,.filters-modal,.modalback:has(.invite-modal),.modalback:has(.filters-modal){animation:none}}body{overflow-x:hidden;overflow-x:clip}main{position:relative;z-index:0;isolation:isolate}main[data-screen=inbox],main[data-screen=profile]{min-height:100dvh}.floating-actions{z-index:20;isolation:isolate;transform:translate3d(-50%,0,0);backface-visibility:hidden}.floating-actions button{backdrop-filter:none;-webkit-backdrop-filter:none}.chat-input{bottom:calc(94px + env(safe-area-inset-bottom))}.modal:not(.invite-modal):not(.filters-modal):not(.detail-modal){animation:none;transition:none}.modalback:not(:has(.invite-modal)):not(:has(.filters-modal)):not(:has(.detail-modal)){animation:none}.comments,.loading-comments svg{animation:none}.floating-actions{left:0;right:0;margin-left:auto;margin-right:auto;transform:none;backface-visibility:visible;will-change:auto;opacity:1;visibility:visible}.detail-modal>.modal-heading{margin:0;padding:20px 58px 16px 22px;min-height:64px}.detail-modal>.close{top:12px;right:12px}.detail-modal>.sheet-handle{margin:0 auto;height:24px}.detail-modal .post{padding-top:10px}.modalback:has(.detail-modal){align-items:flex-end;padding:0;animation:sheet-backdrop-in .22s ease-out}.detail-modal{animation:sheet-rise-in .32s cubic-bezier(.22,.8,.25,1)}.detail-modal.sheet-dragging{animation:none}@media(prefers-reduced-motion:reduce){.detail-modal,.modalback:has(.detail-modal){animation:none}}.floating-actions[popover]{position:fixed;top:auto;left:0;right:0;bottom:calc(22px + env(safe-area-inset-bottom));width:min(600px,100%);height:58px;max-width:none;max-height:none;margin:0 auto;padding:0;border:0;background:transparent;color:inherit;overflow:visible;transform:none;outline:none}.floating-actions[popover]:not(:popover-open){display:none!important}.floating-actions[popover]::backdrop{background:transparent;pointer-events:none}@media(max-width:640px){.floating-actions[popover]{bottom:calc(18px + env(safe-area-inset-bottom))}}html,body{height:100%;overflow:hidden}body{height:100dvh}body>main{position:fixed;inset:0;width:100%;height:100dvh;min-height:0!important;margin:0 auto;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain}.screen-feed{scroll-snap-type:none}.screen-feed main{scroll-snap-type:y mandatory;scroll-padding-top:0}#feed-list{padding-bottom:0}.page-sentinel{height:80px;margin-bottom:calc(96px + env(safe-area-inset-bottom))}html:not(.screen-feed) #feed-list:has(+.page-sentinel[hidden]){padding-bottom:calc(96px + env(safe-area-inset-bottom))}.screen-feed .page-sentinel:not([hidden]){scroll-snap-align:end}.reef-load-trigger{display:grid;place-items:center;width:64px;height:64px;border-radius:50%}.reef-loader{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px}.reef-loader-rings{display:block;position:relative;width:40px;height:32px;animation:reef-loader-breathe 1.4s ease-in-out infinite}.reef-loader-rings>span{position:absolute;width:25px;height:25px;top:0;left:0;border:3px solid var(--accent);border-radius:50%;opacity:.8}.reef-loader-rings>span+span{top:6px;left:14px;border-color:var(--purple);opacity:.5}.reef-load-retry{border:1px solid var(--line);border-radius:12px;background:var(--surface-soft)}@keyframes reef-loader-breathe{0%,to{transform:scale(.88);opacity:.5}50%{transform:scale(1);opacity:1}}@media(prefers-reduced-motion:reduce){.reef-loader-rings{animation:none}}.central-icon-window{position:relative;display:block;width:30px;height:30px;overflow:hidden;isolation:isolate;pointer-events:none}.central-icon{position:absolute;inset:0;display:grid;place-items:center}.create-button .central-icon svg{width:29px;height:29px}.avatar{position:relative;overflow:visible}.avatar-online{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border:2px solid var(--surface);background:#68b495;border-radius:50%;z-index:1}.profile-avatar .avatar-online{width:17px;height:17px;right:3px;bottom:3px;border-width:3px}.photo-static{cursor:default}.insta-zoom-overlay{position:fixed;inset:0;z-index:100;pointer-events:none;transition:background .18s ease}.insta-zoom-overlay img{max-width:none;max-height:none;will-change:transform}.postfoot .post-like-count{font-size:12px;min-width:22px;margin-left:-19px;margin-right:-7px;color:var(--muted)}.post-hidden-from{flex-shrink:0;margin-top:10px;font-size:10px;color:var(--muted);max-height:110px;overflow:auto}.post-hidden-from summary{display:flex;align-items:center;gap:5px;cursor:pointer;line-height:1.5}.post-hidden-from svg{width:12px;height:12px}.post-hidden-from p{font-size:10px;margin:7px 0;line-height:1.5}.posttext a,.comment-text a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}.comment{display:flex;gap:9px;align-items:flex-start}.comment-avatar{padding:0;flex-shrink:0}.comment-avatar .avatar{width:31px;height:31px;font-size:10px}.comment .comment-content{flex:1;min-width:0;display:flex;gap:8px}.comment-copy{flex:1;min-width:0}.comment-author{padding:0;font-size:12px;text-align:left}.comment-text{white-space:pre-wrap;line-height:1.55;margin-top:3px}.comment-reply-button{font-size:10px;color:var(--muted);padding:5px 0;min-height:28px}.comment-reply-quote{border-left:2px solid var(--accent);padding:5px 8px;margin:7px 0;background:var(--surface-soft);border-radius:0 8px 8px 0}.comment-reply-quote strong{display:block;font-size:10px;color:var(--accent)}.comment-reply-quote small{font-size:10px;display:block;line-height:1.4}.comment-input-wrap{flex:1;min-width:0}.replying-to{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--accent);padding:6px 10px;background:var(--surface-soft);border-radius:10px 10px 0 0}.replying-to button{min-width:24px!important;min-height:24px!important;font-size:17px}.composer-modal .sheet-handle{display:none}.composer-modal{padding-top:25px;max-height:94dvh}.composer-author{display:flex;align-items:center;gap:10px;padding:4px 0 12px}.composer-author .avatar{width:38px;height:38px}.composer-author strong{display:block;font-size:13px;font-weight:600}.composer-author small{display:block;font-size:10px;line-height:1.5;color:var(--muted);margin-top:4px}.compose-input{resize:none!important;font-size:17px;line-height:1.55;min-height:150px;max-height:320px;color:var(--ink);padding:12px 0}.compose-input::placeholder{color:var(--muted)}.composer-modal .compose-tools{justify-content:flex-start;gap:10px;border:0;padding:8px 0}.composer-modal .compose-tools button{background:var(--surface-soft);color:var(--accent);border:1px solid var(--line);padding:8px 12px;border-radius:20px;font-size:11px;min-height:38px}.composer-audience{display:flex;align-items:center;gap:11px;width:100%;border:1px solid var(--line);border-radius:15px;padding:13px;text-align:left;margin-top:14px;background:var(--field)}.composer-audience>span{flex:1;min-width:0}.composer-audience strong{display:block;font-size:11px;font-weight:600}.composer-audience small{display:block;font-size:10px;color:var(--muted);line-height:1.5;margin-top:3px}.composer-audience>svg{width:19px;color:var(--accent)}.composer-footer{position:sticky;bottom:-25px;background:var(--surface);padding:12px 0 3px;z-index:2}.composer-footer #publish-button{margin-top:4px;border-radius:15px;min-height:49px;font-size:13px;box-shadow:0 4px 14px #83719e22}.composer-footer #publish-button:active{transform:scale(.985)}.composer-thumb .tag-attachment{position:absolute;inset:auto auto 5px 5px;width:auto;min-width:28px;height:28px;display:flex;align-items:center;gap:2px;padding:5px;border-radius:9px;background:#fffe;color:#83719e;font-size:10px}.tag-attachment svg{width:16px;height:16px}.composer-thumb .remove-attachment{background:#1a142788;color:#fff}.upload-progress{display:flex;align-items:center;gap:10px;padding:12px;background:var(--surface-soft);border-radius:13px;margin:10px 0}.upload-progress-icon{display:grid;place-items:center;width:32px;height:32px;background:var(--surface);color:var(--accent);border-radius:10px}.upload-progress>span:last-child{flex:1;min-width:0}.upload-progress strong{display:block;font-size:11px;color:var(--ink)}.upload-progress small{display:block;font-size:10px;color:var(--muted);margin-top:3px}.upload-progress-track{display:block;height:3px;background:var(--line);border-radius:5px;overflow:hidden;margin-top:7px}.upload-progress-track>span{height:100%;display:block;border-radius:5px;background:var(--accent);transition:width .2s ease}.post-actions{display:grid;gap:9px}.post-actions>button{display:flex;align-items:center;gap:13px;text-align:left;min-height:66px;border-radius:15px;padding:14px;background:var(--surface-soft);border:1px solid var(--line);color:var(--accent)}.post-actions>button>span{flex:1}.post-actions strong{display:block;font-size:13px;font-weight:600;color:var(--ink)}.post-actions small{display:block;font-size:10px;color:var(--muted);margin-top:4px}.post-actions>button.danger{background:var(--surface)}.post-actions>button.danger>svg,.post-actions>button.danger strong{color:#c47887}.delete-post-confirm,.message-restriction{text-align:center}.delete-post-confirm>svg,.message-restriction>svg{width:42px;height:42px;color:var(--accent);margin:10px 0}.danger-button,.secondary-button{display:block;min-height:44px;width:100%;padding:12px;border-radius:12px;font-size:12px}.danger-button{background:#bc687a;color:#fff;margin-top:22px}.secondary-button{background:var(--surface-soft);color:var(--accent);border:1px solid var(--line);margin-top:10px}.message-restriction h3{font-size:18px;font-weight:600}.people-row{display:flex;align-items:center;gap:12px;width:100%;min-height:64px;padding:12px 0;text-align:left;border-bottom:1px solid var(--line)}.people-row>span{flex:1;min-width:0}.people-row strong{display:block;font-size:13px;font-weight:550}.people-row small{display:block;font-size:11px;color:var(--muted);margin-top:5px}.people-row>svg{width:16px;color:var(--muted)}.people-empty{padding:24px;text-align:center}.poll-voters{font-size:11px;color:var(--accent);min-height:32px;padding:5px 0}.poll-option.selected{box-shadow:0 0 0 1px var(--accent)}.photo-tags{position:absolute;inset:0;pointer-events:none}.photo-tag-dot{position:absolute;transform:translate(-50%,-50%);width:27px;height:27px;border:2px solid #fff;border-radius:50%;background:#83719ecf;color:#fff;display:grid;place-items:center;pointer-events:auto;box-shadow:0 2px 10px #0003}.photo-tag-dot svg{width:14px;height:14px}.photo-tag-card{position:absolute;transform:translate(-50%);width:200px;max-width:calc(100% - 20px);padding:12px;border-radius:14px;background:var(--surface);color:var(--ink);box-shadow:0 8px 25px #0003;pointer-events:auto;z-index:5;text-align:left}.photo-tag-person{display:flex;align-items:center;gap:8px;padding:0;width:100%;text-align:left}.photo-tag-person .avatar{width:30px;height:30px;font-size:10px}.photo-tag-person strong{font-size:11px}.photo-tag-card p{font-size:11px!important;line-height:1.5!important;white-space:pre-wrap;color:var(--text-soft);margin:10px 0 0}.photo-tag-card textarea{width:100%;font-size:12px;line-height:1.5;min-height:62px;max-height:90px;resize:none;background:var(--field);border:1px solid var(--line);border-radius:9px;padding:7px;color:var(--ink);margin-top:10px}.photo-tag-card>small{font-size:9px;color:var(--muted)}.photo-tag-save{display:block;margin-top:6px;font-size:10px;color:var(--accent);padding:4px 0}.tag-editor-photo{position:relative;aspect-ratio:1;overflow:hidden;border-radius:16px;background:var(--field);cursor:crosshair}.tag-editor-photo>img{display:block;width:100%;height:100%;object-fit:cover}.tag-editor-photo #tag-editor-points{position:absolute;inset:0;pointer-events:none}.tag-editor-photo #tag-editor-points>span{position:absolute;transform:translate(-50%,-50%);width:26px;height:26px;display:grid;place-items:center;color:#fff;background:#83719ecc;border:2px solid white;border-radius:50%}.tag-editor-photo #tag-editor-points svg{width:14px;height:14px}#tag-editor-people{max-height:220px;overflow:auto}.tag-clear{font-size:11px;color:var(--accent);padding:12px 0}.friend-invite-code{font-size:28px;font-weight:650;letter-spacing:3px;text-align:center;color:var(--accent);background:var(--surface-soft);padding:24px 10px;border:1px solid var(--line);border-radius:16px;margin:20px 0}#friend-code{text-transform:uppercase;letter-spacing:3px;font-weight:600}.request-section{padding:8px 16px 30px}.request-section h2{font-size:12px;color:var(--muted);font-weight:500;margin:22px 0 12px}.request-row{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;margin-bottom:12px;box-shadow:0 3px 12px #25152c04}.request-person strong{font-size:14px;font-weight:550}.friend-request-actions{gap:8px;margin-top:12px}.friend-request-actions button{border:1px solid var(--line);background:var(--surface-soft);color:var(--accent);border-radius:11px;min-height:39px;padding:9px 15px;font-size:11px}.friend-request-actions .accept-friend{background:var(--action);border-color:var(--action);color:var(--on-action)}.chat-thread{background:var(--field);min-height:calc(100dvh - 70px);gap:8px;padding:16px 14px 175px}.chat-thread .bubble{position:relative;background:var(--surface);border:0;border-radius:16px 16px 16px 5px;padding:9px 11px 5px;box-shadow:0 1px 2px #19122012;max-width:min(85%,380px)}.chat-thread .bubble.own{background:var(--surface-soft);border-radius:16px 16px 5px}.message-text{font-size:14px;line-height:1.45;color:var(--ink)}.message-meta{gap:10px;margin-top:2px;min-height:24px}.message-meta time{font-size:9px;white-space:nowrap;opacity:.8}.message-like{margin-right:auto;border-radius:12px;padding:3px 6px;min-height:24px;gap:4px}.message-like.liked{background:var(--surface);box-shadow:0 1px 2px #00000008}.bubble:not(.own) .message-like.liked{background:var(--surface-soft)}.chat-input{border-radius:22px;padding:8px 10px;background:var(--surface);box-shadow:0 3px 14px #1a10220c}.chat-input input{background:transparent}.chat-input>button{display:grid;place-items:center;background:var(--action);color:var(--on-action);border-radius:50%;width:36px;height:36px;padding:9px}.chat-input>button svg{width:18px;height:18px}body>main,.screen-feed body>main{max-width:none}body>main>*{max-width:600px;margin-left:auto;margin-right:auto}.screen-feed body>main>#feed-list{max-width:700px}.screen-feed body>main>#page-sentinel{max-width:700px}@media(prefers-reduced-motion:reduce){.upload-progress-track>span,.insta-zoom-overlay{transition:none}}.bubble:before{content:"";position:absolute;left:-5px;bottom:0;width:9px;height:12px;background:var(--surface);clip-path:polygon(0 100%,100% 0,100% 100%)}.bubble.own:before{left:auto;right:-5px;transform:scaleX(-1);background:var(--surface-soft)}.new-posts-prompt{position:fixed;top:calc(16px + env(safe-area-inset-top));left:50%;transform:translate(-50%);z-index:16;background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 3px 18px #0002;color:var(--accent);padding:11px 18px;font-size:12px}.photo-tag-card{max-height:75%;overflow:auto}.request-row{display:block}.request-person{display:flex;align-items:center;gap:12px;width:100%;text-align:left}.request-person strong{overflow-wrap:anywhere}.request-row .friend-request-actions{display:flex}.request-row .friend-request-actions button{flex:1}.profile-bio{text-align:left}.grid-text{background:linear-gradient(145deg,var(--surface-soft),var(--field) 52%,var(--soft));color:var(--text-soft)}.poll-option.selected{box-shadow:inset 0 0 0 1px var(--accent)}.post-poll{padding:12px 2px;overflow-x:hidden}.poll-option{box-sizing:border-box;white-space:normal}.photo-tag-dot{width:28px;height:28px;padding:6px;border:1px solid #ffffff70;border-radius:10px;background:#35283d66;color:#fff;box-shadow:0 1px 5px #0002;backdrop-filter:blur(5px);opacity:.78}.photo-tag-dot svg{display:block;width:14px;height:14px;stroke-width:1.7}.photo-tag-dot:active{opacity:1}.tag-card-actions{display:flex;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:10px;padding-top:8px}.tag-card-actions button{font-size:10px;color:var(--accent);padding:5px 0}.media-slide .photo-static{position:relative;display:flex;align-items:center;justify-content:center;background:var(--field)}.media-slide .photo-static img{object-fit:contain;width:100%;height:100%;border-radius:16px}.media-slide .photo-static:has(img){overflow:hidden}.tag-editor-photo>img{object-fit:contain}.tag-editor-photo #tag-editor-points>button{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;width:30px;height:30px;padding:6px;border:1px solid #fff9;border-radius:10px;color:#fff;background:#35283d88;display:grid;place-items:center}.draft-tag-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:12px}.draft-tag-row span{flex:1}.draft-tag-row button{color:var(--accent);font-size:11px;padding:8px}.tag-editor-hint{font-size:12px;color:var(--muted)}.composer-thumb video{width:100%;height:100%;object-fit:cover;border-radius:16px}.crop-attachment{position:absolute;left:5px;top:5px;background:#35283d88;color:#fff;border-radius:8px;width:27px;height:27px;padding:6px}.crop-attachment svg{width:15px;height:15px}.composer-thumb .tag-attachment{padding:5px}.composer-thumbs img{object-fit:contain;background:var(--field)}.comment-reply-quote{display:block;text-align:left;width:100%;white-space:normal;border:0;border-left:2px solid var(--accent);background:var(--surface-soft);border-radius:4px 9px 9px 4px;padding:7px 9px;margin:7px 0;color:var(--text-soft)}.comment-reply-quote strong,.comment-reply-quote small{display:block;overflow-wrap:anywhere}.comment-highlight{animation:comment-flash 1.8s ease-out;border-radius:12px}@keyframes comment-flash{0%,28%{background:var(--soft);box-shadow:0 0 0 5px var(--soft)}to{background:transparent;box-shadow:0 0 0 0 transparent}}.comment-media{display:block;max-width:100%;width:220px;max-height:280px;object-fit:contain;border-radius:16px;margin:8px 0}.comment-photo{display:block;max-width:220px;height:auto}.comment-photo img{width:100%;height:auto;object-fit:contain}.comment-media.square-video{width:220px;aspect-ratio:1;object-fit:cover;background:var(--field)}.comment-form{flex-wrap:wrap;gap:6px;align-items:center}.comment-form .comment-input-wrap{flex:1 1 130px;min-width:0}.comment-form>button{flex-shrink:0;width:30px;height:34px;padding:6px}.comment-form>button svg{width:19px;height:19px}.comment-restricted{font-size:12px;color:var(--muted);padding:12px 0}.comment-restricted~.comment-form{display:none}.comment-attachment-slot:empty{display:none}.comment-attachment-slot{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted);padding:8px 0}.comment-attachment-slot img{width:52px;height:52px;object-fit:contain;border-radius:10px;background:var(--field)}.comment-attachment-slot button{margin-left:auto;padding:10px}.comment-policy-choices{display:grid;gap:8px;margin:18px 0}.comment-policy-choices .depth-card{padding:14px;gap:10px}.mini-spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:reef-spin .8s linear infinite}@keyframes reef-spin{to{transform:rotate(360deg)}}.chat-date{align-self:center;margin:14px 0 8px;text-align:center;font-size:10px;color:var(--muted);width:100%}.chat-date time{display:inline-block;background:var(--surface);border-radius:14px;padding:6px 12px}.screen-feed .text-only.has-poll .posttext{flex:0 1 auto;max-height:24%;min-height:36px;display:block;padding:6px 0;overflow:auto}.screen-feed .text-only.has-poll .posttext>p:first-child,.screen-feed .text-only.has-poll .posttext>p:last-child{margin-top:0;margin-bottom:8px}.screen-feed .post.has-poll .post-poll{flex:1 1 auto;min-height:0;max-height:none;margin:auto 0;overflow-y:auto;padding:8px 2px}.screen-feed .post.has-poll .gallery-wrap{flex:1 1 38%;min-height:100px;max-height:42%}.screen-feed .post.has-poll .poll-option{min-height:38px;padding:10px 12px;margin-bottom:7px}.screen-feed .post.has-poll .poll-option>span:not(.poll-bar){font-size:12px}.screen-feed .post.has-poll .postfoot{margin-top:4px}.screen-feed .has-poll .post-poll>small{margin:4px 0 7px}.screen-feed .post.has-poll .posttext{max-height:20%;font-size:14px}body>main{isolation:isolate;will-change:auto}.square-video{border-radius:16px;object-fit:contain;background:var(--field)}.square-overlay{position:fixed;inset:0;z-index:150;background:#17131dcc;backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto}.square-recorder{position:relative;width:min(100%,390px);max-height:calc(100dvh - 40px);overflow:auto;border-radius:24px;background:var(--surface);padding:24px;text-align:center;color:var(--ink)}.square-recorder h2{font-size:20px;margin:0 0 6px}.square-recorder>p{font-size:12px;color:var(--muted)}.square-close{position:absolute;right:12px;top:10px;font-size:26px;padding:5px 10px}.square-stage{position:relative;aspect-ratio:1;border-radius:24px;overflow:hidden;background:var(--field);margin:20px 0 12px}.square-stage canvas,.square-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:24px}.square-stage video{visibility:hidden}.square-preview .square-stage canvas{display:none}.square-preview .square-stage video{visibility:visible}.square-controls{display:flex;gap:10px;align-items:center;justify-content:center;min-height:68px}.square-controls .primary,.square-controls .secondary-button{margin:0;flex:1}.square-record{width:60px;height:60px;border:4px solid var(--surface);outline:2px solid var(--accent);background:var(--accent);border-radius:50%;color:#fff;font-size:24px;transition:border-radius .15s}.square-record.recording{border-radius:20px;background:#bd6475}.square-status{font-size:12px;min-height:24px;line-height:1.5;color:var(--muted);margin-bottom:12px}.square-recorder .auth-switch{margin:16px auto 0}.square-recorder .primary{min-width:0}@media(prefers-reduced-motion:reduce){.comment-highlight,.mini-spinner{animation:none}button{transition:none}}.square-overlay{overscroll-behavior:contain}.draft-tag-row{flex-wrap:wrap}.draft-tag-row>span{min-width:80px}.draft-tag-row>button{min-height:34px}\n', "type": "text/css;charset=utf-8" }, "/qr.js": { "body": `//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\\u0020width="';
      img += size;
      img += '"';
      img += '\\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '\u2588\u2588': '\u2588',
        '\u2588 ': '\u2580',
        ' \u2588': '\u2584',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '\u2588\u2588': '\u2580',
        '\u2588 ': '\u2580',
        ' \u2588': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '\u2588';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '\u2588';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('\u2580');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('\u2588\u2588');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));
`, "type": "application/javascript;charset=utf-8" }, "/sw.js": { "body": "self.addEventListener('install',()=>self.skipWaiting());\nself.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));\nself.addEventListener('push',event=>{event.waitUntil((async()=>{let data={title:'Reef',body:'\u041D\u043E\u0432\u043E\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u0432 \u0432\u0430\u0448\u0435\u043C \u043A\u0440\u0443\u0433\u0435',url:'/#notifications'};try{data={...data,...event.data.json()}}catch{}const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows)client.postMessage({type:'reef-push'});await self.registration.showNotification(data.title,{body:data.body,icon:'/icon.svg',badge:'/icon.svg',tag:data.tag,data:{url:'/#notifications'}})})())});\nself.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const url=new URL('/#notifications',self.location.origin).href;const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows){if(new URL(client.url).origin===self.location.origin){await client.navigate(url);await client.focus();return}}await self.clients.openWindow(url)})())});\n", "type": "application/javascript" }, "/icon.svg": { "body": '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="44" fill="#f0edfc"/><circle cx="77" cy="84" r="36" fill="none" stroke="#7462df" stroke-width="18"/><circle cx="115" cy="109" r="36" fill="none" stroke="#afa1f0" stroke-width="18"/></svg>\n', "type": "image/svg+xml" }, "/manifest.webmanifest": { "body": '{"name": "Reef", "short_name": "Reef", "start_url": "/", "display": "standalone", "background_color": "#ffffff", "theme_color": "#ffffff", "lang": "ru", "icons": [{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}]}', "type": "application/manifest+json" } };

// worker/index.mjs
var now6 = () => Math.floor(Date.now() / 1e3);
var id = () => crypto.randomUUID();
var stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
var one = (env, sql, ...args) => stmt(env, sql, ...args).first();
var rows = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results;
async function body(request, max = 16e3) {
  const b = await bounded(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(b));
  } catch {
    fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
  }
}
async function bounded(request, max) {
  if (Number(request.headers.get("content-length")) > max) fail(413, "\u0424\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0, chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      fail(413, "\u0424\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
}
async function rate(env, key, max, seconds = 900) {
  const k = await hash(key) + ":" + Math.floor(now6() / seconds), r = await one(env, "INSERT INTO limits (key,hits,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits", k, now6() + seconds);
  if (r.hits > max) fail(429, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043F\u043E\u043F\u044B\u0442\u043E\u043A. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.");
}
async function member(request, env, required = true) {
  const token = request.headers.get("cookie")?.match(/(?:^|;\s*)__Host-reef=([A-Za-z0-9_-]+)/)?.[1];
  const m = token ? await one(env, "SELECT m.* FROM sessions s JOIN members m ON m.id=s.member WHERE s.hash=? AND s.expires>?", await hash(token), now6()) : null;
  if (!m && required) fail(401, "\u0412\u043E\u0439\u0434\u0438\u0442\u0435 \u0432 Reef");
  return m;
}
async function session(env, memberId) {
  const token = randomToken();
  await stmt(env, "INSERT INTO sessions(hash,member,expires) VALUES (?,?,?)", await hash(token), memberId, now6() + 30 * 86400).run();
  return "__Host-reef=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000";
}
function publicMember(m) {
  return { id: m.id, name: m.name, role: m.role, online: !m.invisible, feedMode: m.feed_mode, invisible: !!m.invisible, bio: m.bio, avatar: m.avatar_id ? "/media/" + m.avatar_id + "?thumb=1" : null, depth: m.depth, muted: JSON.parse(m.muted) };
}
async function network(env, memberId) {
  const [people, edges] = await Promise.all([rows(env, "SELECT id,name,avatar_id FROM members"), rows(env, "SELECT a,b FROM friends")]);
  return { people: await enrichPeople(env, people), graph: graphFor(memberId, edges, people) };
}
async function readPost(env, viewer, postId) {
  const p = await one(env, "SELECT * FROM posts WHERE id=?", postId);
  if (!p) fail(404, "\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
  if (p.author === viewer) return p;
  if (await one(env, "SELECT member FROM exclusions WHERE post=? AND member=?", postId, viewer)) fail(404, "\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
  if (p.global) return p;
  const { graph } = await network(env, viewer);
  if (!canRead(p, viewer, graph)) fail(404, "\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
  return p;
}
function credentials(d) {
  const email = typeof d.email === "string" ? d.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) fail(400, "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043F\u043E\u0447\u0442\u0443");
  if (typeof d.password !== "string" || d.password.length < 10 || d.password.length > 128) fail(400, "\u041F\u0430\u0440\u043E\u043B\u044C \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \u043E\u0442 10 \u0434\u043E 128 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
  return email;
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    if (request.headers.get("origin") !== url.origin) fail(403, "\u0417\u0430\u043F\u0440\u043E\u0441 \u0441 \u0434\u0440\u0443\u0433\u043E\u0433\u043E \u0441\u0430\u0439\u0442\u0430 \u0437\u0430\u043F\u0440\u0435\u0449\u0451\u043D");
    if (!path.startsWith("/reef-api/")) fail(404, "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
  }
  const inviteCodeResponse = await invitationCodeApi(request, env, { rate, body, one });
  if (inviteCodeResponse) return inviteCodeResponse;
  if (path === "/reef-api/me") {
    const m = await member(request, env, false);
    return json({ user: m ? publicMember(m) : null });
  }
  if (path === "/reef-api/auth/logout" && method === "POST") {
    const token = request.headers.get("cookie")?.match(/(?:^|;\s*)__Host-reef=([A-Za-z0-9_-]+)/)?.[1];
    if (token) await stmt(env, "DELETE FROM sessions WHERE hash=?", await hash(token)).run();
    return new Response("{}", { headers: { "content-type": "application/json", "set-cookie": "__Host-reef=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0", "cache-control": "no-store" } });
  }
  if (path === "/reef-api/auth/login" && method === "POST") {
    const d = await body(request), email = credentials(d);
    await rate(env, "login-ip:" + request.headers.get("cf-connecting-ip"), 30);
    await rate(env, "login-email:" + email, 15);
    const m = await one(env, "SELECT * FROM members WHERE email=?", email);
    const dummy = "00000000-0000-0000-0000-000000000000:" + "0".repeat(64);
    const valid = await checkPassword(d.password, m?.password || dummy, env.REEF_PASSWORD_PEPPER);
    if (!m || !valid) fail(401, "\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u043F\u043E\u0447\u0442\u0430 \u0438\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C");
    return new Response(JSON.stringify({ user: publicMember(m) }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": await session(env, m.id) } });
  }
  if (path === "/reef-api/invite/info" && method === "POST") {
    const d = await body(request), h = await resolveInviteHash(env, String(d.token || ""));
    if (h === env.REEF_SETUP_HASH && !await one(env, "SELECT id FROM members LIMIT 1")) return json({ name: "Reef", setup: true });
    const invite = await one(env, "SELECT m.name FROM invites i JOIN members m ON m.id=i.inviter WHERE i.hash=? AND i.claimed_by IS NULL AND i.expires>?", h, now6());
    if (!invite) fail(410, "\u041F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E \u0438\u043B\u0438 \u0441\u0440\u043E\u043A \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u0438\u0441\u0442\u0451\u043A");
    return json(invite);
  }
  if (path === "/reef-api/auth/register" && method === "POST") {
    const d = await body(request), email = credentials(d);
    await rate(env, "register-ip:" + request.headers.get("cf-connecting-ip"), 15);
    const name = String(d.name || "").trim();
    if (name.length < 2 || name.length > 60) fail(400, "\u0418\u043C\u044F \u0434\u043E\u043B\u0436\u043D\u043E \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \u043E\u0442 2 \u0434\u043E 60 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
    if (await one(env, "SELECT id FROM members WHERE email=?", email)) fail(409, "\u042D\u0442\u0430 \u043F\u043E\u0447\u0442\u0430 \u0443\u0436\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u0430");
    const h = await resolveInviteHash(env, String(d.token || "")), uid = id(), pw = await passwordHash(d.password, env.REEF_PASSWORD_PEPPER);
    let result;
    if (h === env.REEF_SETUP_HASH) {
      result = await env.DB.batch([stmt(env, "INSERT INTO members(id,name,email,password,role,created) SELECT ?,?,?,?,'owner',? WHERE NOT EXISTS(SELECT 1 FROM members) AND NOT EXISTS(SELECT 1 FROM settings WHERE key='setup')", uid, name, email, pw, now6()), stmt(env, "INSERT OR IGNORE INTO settings(key,value) SELECT 'setup',id FROM members WHERE id=?", uid)]);
      if (!result[0].meta.changes) fail(410, "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430 \u0443\u0436\u0435 \u0441\u043E\u0437\u0434\u0430\u043D");
    } else {
      result = await env.DB.batch([stmt(env, "UPDATE invites AS target SET claimed_by=? WHERE hash=? AND claimed_by IS NULL AND expires>? AND ((SELECT role FROM members WHERE id=target.inviter) IN ('owner','admin') OR (SELECT count(*) FROM invites used WHERE used.inviter=target.inviter AND used.claimed_by IS NOT NULL)<(SELECT invite_limit FROM members WHERE id=target.inviter))", uid, h, now6()), stmt(env, "INSERT INTO members(id,name,email,password,created) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM invites WHERE hash=? AND claimed_by=?)", uid, name, email, pw, now6(), h, uid), stmt(env, "INSERT OR IGNORE INTO friends(a,b,created) SELECT min(inviter,?),max(inviter,?),? FROM invites WHERE hash=? AND claimed_by=?", uid, uid, now6(), h, uid), stmt(env, "INSERT OR IGNORE INTO notifications(id,recipient,actor,kind,target,created) SELECT 'friend_request:'||?||':'||inviter||':'||inviter,?,inviter,'friend',inviter,? FROM invites WHERE hash=? AND claimed_by=?", uid, uid, now6(), h, uid), stmt(env, "INSERT OR IGNORE INTO notifications(id,recipient,actor,kind,target,created) SELECT 'invite_joined:'||inviter||':'||?||':'||?,inviter,?,'invite_joined',?,? FROM invites WHERE hash=? AND claimed_by=?", uid, uid, uid, uid, now6(), h, uid)]);
      if (!result[0].meta.changes) fail(410, "\u041F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E \u0438\u043B\u0438 \u0441\u0440\u043E\u043A \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u0438\u0441\u0442\u0451\u043A");
    }
    return new Response(JSON.stringify({ user: publicMember(await one(env, "SELECT * FROM members WHERE id=?", uid)) }), { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": await session(env, uid) } });
  }
  if (path.startsWith("/reef-api/") || path.startsWith("/media/")) {
    const m = await member(request, env);
    const extra = await features(request, env, m, { stmt, one, rows, body, rate, network, readPost, bounded });
    if (extra) return extra;
    if (path === "/reef-api/invites" && method === "POST") {
      await rate(env, "invites:" + m.id, 20, 86400);
      const token = randomToken(), expires = now6() + 7 * 86400;
      await stmt(env, "INSERT INTO invites(hash,inviter,expires,created) VALUES (?,?,?,?)", await hash(token), m.id, expires, now6()).run();
      return json({ url: url.origin + "/#invite=" + token, expires }, 201);
    }
    if (path === "/reef-api/preferences" && method === "PUT") {
      const d = await body(request);
      if (![1, 2, 3].includes(d.depth) || !Array.isArray(d.muted) || d.muted.length > 200 || d.muted.some((x) => typeof x !== "string")) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438");
      await stmt(env, "UPDATE members SET depth=?,muted=? WHERE id=?", d.depth, JSON.stringify([...new Set(d.muted)]), m.id).run();
      return json({ ok: true });
    }
    if (path === "/reef-api/audience") {
      const depth = Number(url.searchParams.get("depth") || 3);
      if (![1, 2, 3].includes(depth)) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0433\u043B\u0443\u0431\u0438\u043D\u0430");
      const { people, graph } = await network(env, m.id);
      return json({ people: people.filter((p) => p.id !== m.id && graph.get(p.id)?.depth <= depth).map((p) => ({ ...p, degree: graph.get(p.id).depth })) });
    }
    if (path === "/reef-api/friends" && method === "POST") {
      const d = await body(request);
      if (typeof d.member !== "string" || d.member === m.id) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A");
      const { graph } = await network(env, m.id);
      if (!graph.has(d.member)) fail(404, "\u0423\u0447\u0430\u0441\u0442\u043D\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
      await stmt(env, "INSERT OR IGNORE INTO friends(a,b,created) VALUES (min(?,?),max(?,?),?)", m.id, d.member, m.id, d.member, now6()).run();
      return json({ ok: true });
    }
    if (path === "/reef-api/posts" && method === "GET") {
      const { people, graph } = await network(env, m.id), muted = JSON.parse(m.muted);
      const authors = [...graph].filter(([i, g]) => i === m.id || g.depth <= m.depth && !muted.includes(i)).map(([i]) => i);
      let candidates = [];
      for (let start = 0; start < authors.length; start += 50) {
        const ids = authors.slice(start, start + 50);
        const ps2 = await rows(env, `SELECT p.*,u.name,(SELECT count(*) FROM likes l WHERE l.post=p.id) AS likes,(SELECT count(*) FROM comments c WHERE c.post=p.id) AS comment_count,EXISTS(SELECT 1 FROM likes l WHERE l.post=p.id AND l.member=?) AS liked FROM (SELECT *,row_number() OVER(PARTITION BY author ORDER BY created DESC,id DESC) AS rn FROM posts WHERE author IN (${ids.map(() => "?").join(",")})) p JOIN members u ON u.id=p.author WHERE p.rn<=25 AND NOT EXISTS(SELECT 1 FROM exclusions e WHERE e.post=p.id AND e.member=?)`, m.id, ...ids, m.id);
        candidates.push(...ps2);
      }
      const names = new Map(people.map((p) => [p.id, p.name]));
      const ps = candidates.filter((p) => canRead(p, m.id, graph)).sort((a, b) => b.created - a.created).map((p) => {
        const g = graph.get(p.author);
        const via = g.depth === 1 ? "\u0412\u0430\u0448 \u0434\u0440\u0443\u0433" : g.depth === 2 ? "\u0414\u0440\u0443\u0433 " + names.get(g.path[1]) : g.depth === 3 ? "\u0427\u0435\u0440\u0435\u0437 " + names.get(g.path[1]) + " \u0438 " + names.get(g.path[2]) : "";
        return { id: p.id, author: p.author, name: p.name, degree: g.depth, via, created: p.created, text: p.text, photo: p.media_id ? "/media/" + p.media_id : null, likes: p.likes, liked: !!p.liked, commentCount: p.comment_count, audience: p.depth };
      });
      return json({ posts: rank(ps).slice(0, 200) });
    }
    if (path === "/reef-api/posts" && method === "POST") {
      await rate(env, "posts:" + m.id, 100, 86400);
      const d = await body(request, 32e3), text = typeof d.text === "string" ? d.text.trim() : "";
      if (text.length > 5e3 || !text && !d.media || ![1, 2, 3].includes(d.depth) || !Array.isArray(d.excluded) || d.excluded.length > 200 || d.excluded.some((x) => typeof x !== "string")) fail(400, "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u0438 \u0430\u0443\u0434\u0438\u0442\u043E\u0440\u0438\u044E");
      if (d.media) {
        if (!await one(env, "SELECT id FROM media WHERE id=? AND owner=? AND NOT EXISTS(SELECT 1 FROM posts WHERE media_id=?)", d.media, m.id, d.media)) fail(400, "\u0424\u043E\u0442\u043E\u0433\u0440\u0430\u0444\u0438\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430");
      }
      ;
      const pid = id();
      const commands = [stmt(env, "INSERT INTO posts(id,author,text,media_id,depth,created) VALUES (?,?,?,?,?,?)", pid, m.id, text, d.media || null, d.depth, now6()), ...[...new Set(d.excluded)].filter((x) => x !== m.id).map((x) => stmt(env, "INSERT INTO exclusions(post,member) SELECT ?,id FROM members WHERE id=?", pid, x))];
      await env.DB.batch(commands);
      return json({ id: pid }, 201);
    }
    const pm = path.match(/^\/reef-api\/posts\/([^/]+)(?:\/(likes|comments))?$/);
    if (pm) {
      const pid = pm[1], p = await readPost(env, m.id, pid);
      if (pm[2] === "likes" && method === "PUT") {
        const d = await body(request);
        if (typeof d.liked !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
        await stmt(env, d.liked ? "INSERT OR IGNORE INTO likes(post,member) VALUES (?,?)" : "DELETE FROM likes WHERE post=? AND member=?", pid, m.id).run();
        return json({ ok: true });
      }
      if (pm[2] === "comments" && method === "GET") return json({ comments: await rows(env, "SELECT c.id,c.text,c.created,m.name FROM comments c JOIN members m ON m.id=c.member WHERE c.post=? ORDER BY c.created ASC,c.id ASC LIMIT 300", pid) });
      if (pm[2] === "comments" && method === "POST") {
        await rate(env, "comments:" + m.id, 60);
        const d = await body(request), text = typeof d.text === "string" ? d.text.trim() : "";
        if (!text || text.length > 1e3) fail(400, "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \u043E\u0442 1 \u0434\u043E 1000 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
        await stmt(env, "INSERT INTO comments(id,post,member,text,created) VALUES (?,?,?,?,?)", id(), pid, m.id, text, now6()).run();
        return json({ ok: true }, 201);
      }
      if (!pm[2] && method === "DELETE") {
        if (p.author !== m.id) fail(403, "\u041C\u043E\u0436\u043D\u043E \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0432\u043E\u0439 \u043F\u043E\u0441\u0442");
        await env.DB.batch([stmt(env, "DELETE FROM comments WHERE post=?", pid), stmt(env, "DELETE FROM likes WHERE post=?", pid), stmt(env, "DELETE FROM exclusions WHERE post=?", pid), stmt(env, "DELETE FROM posts WHERE id=?", pid)]);
        if (p.media_id) {
          await env.BUCKET.delete(p.media_id);
          await stmt(env, "DELETE FROM media WHERE id=?", p.media_id).run();
        }
        return json({ ok: true });
      }
    }
    if (path === "/reef-api/media" && method === "POST") {
      await rate(env, "upload:" + m.id, 30, 86400);
      const bytes = await bounded(request, 8 * 1024 * 1024), type = imageType(bytes);
      if (!type) fail(400, "\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044E\u0442\u0441\u044F JPEG, PNG \u0438 WebP");
      const mid = id();
      await env.BUCKET.put(mid, bytes, { httpMetadata: { contentType: type } });
      try {
        await stmt(env, "INSERT INTO media(id,owner,type,size,created) VALUES (?,?,?,?,?)", mid, m.id, type, bytes.length, now6()).run();
      } catch (e) {
        await env.BUCKET.delete(mid);
        throw e;
      }
      return json({ id: mid }, 201);
    }
    if (path.startsWith("/media/") && method === "GET") {
      const mid = path.slice(7), image = await one(env, "SELECT * FROM media WHERE id=?", mid);
      if (!image) fail(404, "\u0424\u043E\u0442\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
      const p = await one(env, "SELECT id FROM posts WHERE media_id=?", mid);
      if (p) await readPost(env, m.id, p.id);
      else if (image.owner !== m.id) fail(404, "\u0424\u043E\u0442\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
      const blob = await env.BUCKET.get(mid);
      if (!blob) fail(404, "\u0424\u043E\u0442\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
      return new Response(blob.body, { headers: { "content-type": image.type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    fail(404, "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
  }
  if (method !== "GET" && method !== "HEAD") fail(405, "\u041C\u0435\u0442\u043E\u0434 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F");
  const asset = assets[path === "/" ? "/index.html" : path];
  if (!asset) fail(404, "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
  return new Response(method === "HEAD" ? null : asset.base64 ? Uint8Array.from(atob(asset.body), (c) => c.charCodeAt(0)) : asset.body, { headers: { "content-type": asset.type, "cache-control": path === "/" ? "no-store" : "public,max-age=300", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
var index_default = { async fetch(request, env, ctx) {
  try {
    const response = await handle(request, env);
    if (ctx?.waitUntil && ["POST", "PUT", "DELETE"].includes(request.method)) ctx.waitUntil(deliverPush(env).catch(() => console.error("Reef push dispatch failed")));
    response.headers.set("x-frame-options", "DENY");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch (e) {
    if (!e.status) console.error("Reef request failed", e.message);
    return json({ error: e.status ? e.message : "\u0412\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430" }, e.status || 500);
  }
} };
export {
  index_default as default
};
