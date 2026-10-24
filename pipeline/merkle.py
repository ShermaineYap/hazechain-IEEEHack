"""SHA-256 sorted-pair Merkle tree. Must match lib/merkle.js, web/app.js and EvidenceRegistry.processProof."""
import hashlib
def sha(b): return hashlib.sha256(b).digest()
def leaf(row: str) -> bytes: return sha(row.encode("utf-8"))
def parent(a, b): return sha(a + b) if a <= b else sha(b + a)
def build(leaves):
    levels = [leaves]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        levels.append([parent(cur[i], cur[i + 1]) if i + 1 < len(cur) else cur[i] for i in range(0, len(cur), 2)])
    return levels
def proof(levels, i):
    out = []
    for l in range(len(levels) - 1):
        s = i ^ 1
        if s < len(levels[l]): out.append(levels[l][s])
        i >>= 1
    return out
def verify(leaf_b, prf, root):
    h = leaf_b
    for p in prf: h = parent(h, p)
    return h == root
