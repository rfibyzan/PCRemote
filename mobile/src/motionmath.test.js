import assert from "node:assert/strict";
import { MOTION, panelFrame, staggerDelay } from "./motionmath.js";

assert.deepEqual(panelFrame("pop", 0, 800), { opacity: 0, x: 0, y: 0, scale: MOTION.popFrom });
assert.deepEqual(panelFrame("pop", 1, 800), { opacity: 1, x: 0, y: 0, scale: 1 });
assert.deepEqual(panelFrame("touch", 0, 800, 100, -50), { opacity: 0, x: 100, y: -50, scale: MOTION.touchFrom });
const t1 = panelFrame("touch", 1, 800, 100, -50);
assert.ok(t1.opacity === 1 && t1.scale === 1 && t1.x === 0 && t1.y + 0 === 0);
assert.ok(Math.abs(panelFrame("sheet", 0, 1000).y - 350) < 1e-9);
const over = panelFrame("sheet", 1.05, 1000);
assert.equal(over.opacity, 1);
assert.ok(over.y < 0);
assert.deepEqual(panelFrame("fade", 0.5, 800), { opacity: 0.5, x: 0, y: 0, scale: 1 });
assert.equal(staggerDelay(0, 4), 0);
assert.equal(staggerDelay(3, 4), 0);
assert.ok(staggerDelay(4, 4) > 0);
assert.equal(staggerDelay(999, 4), MOTION.staggerMax);
console.log("motionmath ok");
