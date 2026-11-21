// Run: node src/caretread_test.js
import { EventEmitter } from "node:events";
import { createUiaReader } from "./caretread.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log("FAIL", name);
  }
}

function fakeSpawn() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stdin = new EventEmitter();
  p.written = [];
  p.stdin.write = (s) => p.written.push(s);
  p.kill = () => {};
  const spawn = () => p;
  return { p, spawn };
}

async function main() {
  const { p, spawn } = fakeSpawn();
  const uia = createUiaReader({ spawn });
  // q 1 times out (answer comes late), q 2 must not take q 1's answer.
  const first = await uia.read();
  ok(first === undefined, "timeout reads as no answer (undefined)");
  const second = uia.read();
  p.stdout.emit("data", '{"n":1,"x":5,"y":5,"w":1,"h":10}\n');
  p.stdout.emit("data", '{"n":2,"x":9,"y":9,"w":1,"h":12}\n');
  const v = await second;
  ok(v && v.x === 9 && v.h === 12, "late answer to an old question is dropped");
  ok(p.written.length === 2 && p.written[1] === "q 2\n", "questions are numbered");
  const third = uia.read();
  p.stdout.emit("data", '{"n":3}\n');
  ok((await third) === null, "empty answer = no caret (null)");
  let threw = false;
  try {
    p.stdin.emit("error", new Error("EPIPE"));
  } catch {
    threw = true;
  }
  ok(!threw, "stdin errors are swallowed");
  uia.stop();
  console.log(`${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}
main();
