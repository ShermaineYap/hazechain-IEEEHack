// SHA-256 sorted-pair Merkle tree. Must match pipeline/merkle.py and EvidenceRegistry.processProof.
const crypto = require("crypto");
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const leafOf = (row) => sha(Buffer.from(row, "utf8"));
const parent = (a, b) => (Buffer.compare(a, b) <= 0 ? sha(Buffer.concat([a, b])) : sha(Buffer.concat([b, a])));

function build(leaves) {
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1), nxt = [];
    for (let i = 0; i < cur.length; i += 2) nxt.push(i + 1 < cur.length ? parent(cur[i], cur[i + 1]) : cur[i]);
    levels.push(nxt);
  }
  return levels;
}
function proof(levels, index) {
  const out = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = index ^ 1;
    if (sib < levels[l].length) out.push(levels[l][sib]);
    index >>= 1;
  }
  return out;
}
const hex = (b) => "0x" + b.toString("hex");
module.exports = { sha, leafOf, parent, build, proof, hex };
