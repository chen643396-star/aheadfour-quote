module.exports = async function handler(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, msg: "pong-cjs", method: req.method, node: process.version }));
};
