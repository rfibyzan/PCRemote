// node src/audioproto.test.js
import assert from "node:assert/strict";
import { agentHasAudio, isAudioPacket, parseAudioPacket } from "./audioproto.js";

const pkt = new Uint8Array([0x50, 0x41, 1, 2, 0x34, 0x12, 20, 0, 9, 8, 7]);
assert.ok(isAudioPacket(pkt));
assert.ok(isAudioPacket(pkt.buffer));
const p = parseAudioPacket(pkt.buffer);
assert.equal(p.seq, 0x1234);
assert.equal(p.frameMs, 20);
assert.equal(p.channels, 2);
assert.deepEqual([...p.data], [9, 8, 7]);
assert.ok(!isAudioPacket(new Uint8Array([0x50, 0x56, 0, 0, 0, 0, 0, 0, 1])), "video PV is not audio");
assert.ok(!isAudioPacket(new Uint8Array([0x50, 0x41, 1, 2, 0, 0, 20, 0])), "header only = nothing to play");
assert.equal(parseAudioPacket(null), null);
assert.ok(agentHasAudio({ features: ["lan", "audio"] }));
assert.ok(!agentHasAudio({ features: ["lan"] }));
assert.ok(!agentHasAudio(null));
console.log("audioproto: ok");
