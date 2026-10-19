import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseWholesalerFavorites,
  toggleWholesalerFavorite,
  wholesalerFavoriteKey,
} from "../src/wholesalerFavorites.ts";

test("invalid or old local preferences do not break the wholesaler screen", () => {
  for (const value of [
    null,
    "bad-json",
    "null",
    "{}",
    '[null,3,{"id":4,"name":"약품"}]',
  ])
    assert.deepEqual(parseWholesalerFavorites(value), []);
  assert.deepEqual(
    parseWholesalerFavorites(
      '[{"id":"1","name":"도매상"},{"id":"1","name":"중복"},{"id":"2","name":"  "}]',
    ),
    [{ id: "1", name: "도매상", meta: "" }],
  );
});
test("favorites toggle by stable ID and persist only wholesaler display fields", () => {
  const item = {
    id: "1",
    name: "서울 도매상",
    meta: "공급처",
    extra: "not saved",
  };
  const added = toggleWholesalerFavorite([], item);
  assert.deepEqual(added, [{ id: "1", name: "서울 도매상", meta: "공급처" }]);
  assert.deepEqual(
    toggleWholesalerFavorite(added, { ...item, name: "변경된 이름" }),
    [],
  );
  assert.deepEqual(added, [{ id: "1", name: "서울 도매상", meta: "공급처" }]);
});
test("different pharmacy accounts have independent favorite storage", () => {
  assert.notEqual(wholesalerFavoriteKey("1"), wholesalerFavoriteKey("2"));
  assert.notEqual(wholesalerFavoriteKey("1:2"), wholesalerFavoriteKey("1%3A2"));
});
