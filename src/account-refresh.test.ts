import assert from "node:assert/strict";
import test from "node:test";
import { prioritizeAccount } from "./account-refresh.ts";

const accounts = [{ id: "first" }, { id: "active" }, { id: "last" }];

test("refreshes the active account first while preserving the remaining order", () => {
  assert.deepEqual(
    prioritizeAccount(accounts, "active").map((account) => account.id),
    ["active", "first", "last"],
  );
});

test("keeps configured order when the active account is absent", () => {
  assert.deepEqual(
    prioritizeAccount(accounts, "other").map((account) => account.id),
    ["first", "active", "last"],
  );
});
