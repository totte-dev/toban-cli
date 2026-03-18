import { randomUUID } from "node:crypto";

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
}

export interface TodoFilter {
  completed?: boolean;
}

export interface TodoUpdate {
  title?: string;
  completed?: boolean;
}

export interface TodoCount {
  total: number;
  completed: number;
  pending: number;
}

export class TodoStore {
  private todos: Map<string, Todo> = new Map();
  private order: string[] = [];

  add(title: string): Todo {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Title must not be empty");
    }

    const todo: Todo = {
      id: randomUUID(),
      title: trimmed,
      completed: false,
      createdAt: new Date(),
    };

    this.todos.set(todo.id, todo);
    this.order.push(todo.id);
    return todo;
  }

  list(): Todo[] {
    return this.order
      .map((id) => this.todos.get(id))
      .filter((t): t is Todo => t !== undefined);
  }

  get(id: string): Todo | undefined {
    return this.todos.get(id);
  }

  update(id: string, updates: TodoUpdate): Todo {
    const todo = this.todos.get(id);
    if (!todo) {
      throw new Error(`Todo not found: ${id}`);
    }

    if (updates.title !== undefined) {
      const trimmed = updates.title.trim();
      if (!trimmed) {
        throw new Error("Title must not be empty");
      }
      todo.title = trimmed;
    }

    if (updates.completed !== undefined) {
      todo.completed = updates.completed;
    }

    return todo;
  }

  remove(id: string): boolean {
    if (!this.todos.has(id)) {
      return false;
    }
    this.todos.delete(id);
    this.order = this.order.filter((oid) => oid !== id);
    return true;
  }

  filter(criteria: TodoFilter): Todo[] {
    return this.list().filter((todo) => {
      if (criteria.completed !== undefined && todo.completed !== criteria.completed) {
        return false;
      }
      return true;
    });
  }

  count(): TodoCount {
    const all = this.list();
    const completed = all.filter((t) => t.completed).length;
    return {
      total: all.length,
      completed,
      pending: all.length - completed,
    };
  }
}
