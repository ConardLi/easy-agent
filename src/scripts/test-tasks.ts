/**
 * Smoke test for Task V2 store.
 *
 *   npm run test:tasks
 *
 * Covers: create, get, list, update, dependency cascade, delete cascade,
 * reset + high water mark persistence.
 */
import {
  blockTask,
  createTask,
  deleteTask,
  getTask,
  getTaskListId,
  getTasksDir,
  isReady,
  listTasks,
  resetTaskList,
  updateTask,
} from "../state/taskStore.js";

const TASK_LIST_ID = getTaskListId(`test-${Date.now()}`);

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exit(1);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

async function main(): Promise<void> {
  console.log(`Task list dir: ${getTasksDir(TASK_LIST_ID)}`);

  // 1. Create 3 tasks.
  const id1 = await createTask(TASK_LIST_ID, {
    subject: "Plan the work",
    description: "Decide what to do",
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  const id2 = await createTask(TASK_LIST_ID, {
    subject: "Do the work",
    description: "Actually implement",
    activeForm: "Doing the work",
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  const id3 = await createTask(TASK_LIST_ID, {
    subject: "Verify",
    description: "Run tests",
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  assert(id1 === "1" && id2 === "2" && id3 === "3", "ids are 1/2/3 sequential");

  // 2. Wire dependencies: #1 blocks #2 blocks #3.
  await blockTask(TASK_LIST_ID, id1, id2);
  await blockTask(TASK_LIST_ID, id2, id3);

  let all = await listTasks(TASK_LIST_ID);
  const t1 = all.find((t) => t.id === id1)!;
  const t2 = all.find((t) => t.id === id2)!;
  const t3 = all.find((t) => t.id === id3)!;
  assert(t1.blocks.includes(id2) && t2.blockedBy.includes(id1), "bidirectional #1→#2");
  assert(t2.blocks.includes(id3) && t3.blockedBy.includes(id2), "bidirectional #2→#3");

  // 3. isReady picks only the root.
  assert(isReady(t1, all) && !isReady(t2, all) && !isReady(t3, all), "only #1 is ready");

  // 4. Complete #1 — #2 becomes ready.
  await updateTask(TASK_LIST_ID, id1, { status: "completed" });
  all = await listTasks(TASK_LIST_ID);
  const t2After = all.find((t) => t.id === id2)!;
  assert(isReady(t2After, all), "#2 ready after #1 completes");

  // 5. Delete #2 — cascade removes it from #1.blocks and #3.blockedBy.
  await deleteTask(TASK_LIST_ID, id2);
  all = await listTasks(TASK_LIST_ID);
  const t1After = all.find((t) => t.id === id1)!;
  const t3After = all.find((t) => t.id === id3)!;
  assert(!t1After.blocks.includes(id2), "#1.blocks cleaned");
  assert(!t3After.blockedBy.includes(id2), "#3.blockedBy cleaned");

  // 6. Reset preserves the high water mark — new task gets id #4, not #2.
  await resetTaskList(TASK_LIST_ID);
  const all2 = await listTasks(TASK_LIST_ID);
  assert(all2.length === 0, "reset clears tasks");
  const newId = await createTask(TASK_LIST_ID, {
    subject: "Post-reset",
    description: "x",
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  assert(newId === "4", "next id is 4 (HWM respected)");
  const check = await getTask(TASK_LIST_ID, newId);
  assert(check?.subject === "Post-reset", "new task readable");

  // 7. Cleanup
  await resetTaskList(TASK_LIST_ID);
  const final = await listTasks(TASK_LIST_ID);
  assert(final.length === 0, "cleanup reset empty");

  console.log("\nAll task store checks passed.");
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
