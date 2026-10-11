import { expect, test } from "@playwright/test";
import { parsePartialJson, partialInput } from "../../src/renderer/lib/partialJson";

test("complete JSON parses as is", () => {
  expect(parsePartialJson('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
});

test("an open string value is closed where it stops", () => {
  expect(parsePartialJson('{"command":"npm te')).toEqual({ command: "npm te" });
  expect(parsePartialJson('{"content":"line\\nnext')).toEqual({ content: "line\nnext" });
});

test("a cut-off escape is dropped", () => {
  expect(parsePartialJson('{"content":"a\\')).toEqual({ content: "a" });
  expect(parsePartialJson('{"content":"a\\u00')).toEqual({ content: "a" });
});

test("a key or value cut off midway is dropped", () => {
  expect(parsePartialJson('{"file_path":"a.ts","old_')).toEqual({ file_path: "a.ts" });
  expect(parsePartialJson('{"file_path":"a.ts","old_string":')).toEqual({ file_path: "a.ts" });
  expect(parsePartialJson('{"file_path":"a.ts",')).toEqual({ file_path: "a.ts" });
  expect(parsePartialJson('{"replace_all":tr')).toEqual({});
});

test("nested objects and arrays are closed", () => {
  expect(parsePartialJson('{"edits":[{"old_string":"x","new_string":"y"},{"old_string":"z')).toEqual({
    edits: [{ old_string: "x", new_string: "y" }, { old_string: "z" }],
  });
});

test("partialInput only returns objects", () => {
  expect(partialInput(undefined)).toBeUndefined();
  expect(partialInput("")).toBeUndefined();
  expect(partialInput("[1,2")).toBeUndefined();
  expect(partialInput("{")).toEqual({});
  expect(partialInput('{"path":"src')).toEqual({ path: "src" });
});
