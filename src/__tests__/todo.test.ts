import { describe, it, expect, beforeEach } from "vitest";
import { TodoStore, type Todo } from "../todo.js";

describe("TodoStore", () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore();
  });

  describe("add", () => {
    it("creates a todo with title and returns it", () => {
      const todo = store.add("Buy groceries");

      expect(todo.id).toBeDefined();
      expect(todo.title).toBe("Buy groceries");
      expect(todo.completed).toBe(false);
      expect(todo.createdAt).toBeInstanceOf(Date);
    });

    it("assigns unique ids to each todo", () => {
      const todo1 = store.add("Task 1");
      const todo2 = store.add("Task 2");

      expect(todo1.id).not.toBe(todo2.id);
    });

    it("throws on empty title", () => {
      expect(() => store.add("")).toThrow("Title must not be empty");
      expect(() => store.add("  ")).toThrow("Title must not be empty");
    });
  });

  describe("list", () => {
    it("returns empty array when no todos", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns all todos in insertion order", () => {
      store.add("First");
      store.add("Second");

      const todos = store.list();
      expect(todos).toHaveLength(2);
      expect(todos[0].title).toBe("First");
      expect(todos[1].title).toBe("Second");
    });

    it("returns a copy, not the internal array", () => {
      store.add("Task");
      const list1 = store.list();
      const list2 = store.list();

      expect(list1).not.toBe(list2);
    });
  });

  describe("get", () => {
    it("returns a todo by id", () => {
      const created = store.add("Find me");
      const found = store.get(created.id);

      expect(found).toBeDefined();
      expect(found!.title).toBe("Find me");
    });

    it("returns undefined for unknown id", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });
  });

  describe("update", () => {
    it("updates the title", () => {
      const todo = store.add("Old title");
      const updated = store.update(todo.id, { title: "New title" });

      expect(updated.title).toBe("New title");
      expect(updated.completed).toBe(false);
    });

    it("marks as completed", () => {
      const todo = store.add("Do something");
      const updated = store.update(todo.id, { completed: true });

      expect(updated.completed).toBe(true);
    });

    it("throws on unknown id", () => {
      expect(() => store.update("nonexistent", { title: "X" })).toThrow(
        "Todo not found: nonexistent"
      );
    });

    it("throws on empty title update", () => {
      const todo = store.add("Valid");
      expect(() => store.update(todo.id, { title: "" })).toThrow(
        "Title must not be empty"
      );
    });
  });

  describe("remove", () => {
    it("removes a todo by id", () => {
      const todo = store.add("Remove me");
      const removed = store.remove(todo.id);

      expect(removed).toBe(true);
      expect(store.list()).toHaveLength(0);
    });

    it("returns false for unknown id", () => {
      expect(store.remove("nonexistent")).toBe(false);
    });
  });

  describe("filter", () => {
    beforeEach(() => {
      const t1 = store.add("Completed task");
      store.update(t1.id, { completed: true });
      store.add("Pending task");
    });

    it("filters completed todos", () => {
      const completed = store.filter({ completed: true });
      expect(completed).toHaveLength(1);
      expect(completed[0].title).toBe("Completed task");
    });

    it("filters pending todos", () => {
      const pending = store.filter({ completed: false });
      expect(pending).toHaveLength(1);
      expect(pending[0].title).toBe("Pending task");
    });
  });

  describe("count", () => {
    it("returns total, completed, and pending counts", () => {
      expect(store.count()).toEqual({ total: 0, completed: 0, pending: 0 });

      const t1 = store.add("Task 1");
      store.add("Task 2");
      store.update(t1.id, { completed: true });

      expect(store.count()).toEqual({ total: 2, completed: 1, pending: 1 });
    });
  });
});
