import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { capStream, capChunks } from "../../src/sandbox/output-cap.js";

function chunksFrom(...parts: (Buffer | string)[]): Readable {
  return Readable.from(parts);
}

test("capStream stores everything when total bytes are under cap", async () => {
  const result = await capStream(chunksFrom("hello ", "world"), 1000);
  assert.equal(result.content.toString(), "hello world");
  assert.equal(result.truncated, false);
  assert.equal(result.totalBytesSeen, 11);
});

test("capStream stores exactly cap when total bytes equal cap", async () => {
  const result = await capStream(chunksFrom("0123456789"), 10);
  assert.equal(result.content.toString(), "0123456789");
  assert.equal(result.truncated, false);
});

test("capStream truncates when over cap and continues draining", async () => {
  const result = await capStream(chunksFrom("abcdefghij", "klmno"), 7);
  assert.equal(result.content.toString(), "abcdefg");
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytesSeen, 15);
});

test("capStream truncates across chunk boundary", async () => {
  const result = await capStream(chunksFrom("hello", " ", "there"), 7);
  assert.equal(result.content.toString(), "hello t");
  assert.equal(result.truncated, true);
});

test("capStream rejects negative maxBytes", async () => {
  await assert.rejects(() => capStream(chunksFrom("x"), -1));
});

test("capStream with cap of 0 returns empty content and truncated=true when input is non-empty", async () => {
  const result = await capStream(chunksFrom("hi"), 0);
  assert.equal(result.content.length, 0);
  assert.equal(result.truncated, true);
});

test("capStream with cap of 0 and empty input returns empty content, truncated=false", async () => {
  const result = await capStream(chunksFrom(), 0);
  assert.equal(result.content.length, 0);
  assert.equal(result.truncated, false);
});

test("capStream handles Buffer chunks", async () => {
  const result = await capStream(
    chunksFrom(Buffer.from([0x01, 0x02, 0x03]), Buffer.from([0x04, 0x05])),
    10,
  );
  assert.deepEqual(Array.from(result.content), [1, 2, 3, 4, 5]);
});

test("capChunks gives the same shape as capStream for synchronous iterables", () => {
  const result = capChunks(["abc", "def"], 4);
  assert.equal(result.content.toString(), "abcd");
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytesSeen, 6);
});

test("capChunks under cap is not truncated", () => {
  const result = capChunks(["abc"], 10);
  assert.equal(result.content.toString(), "abc");
  assert.equal(result.truncated, false);
});
