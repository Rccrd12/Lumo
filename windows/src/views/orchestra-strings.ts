// The orchestra's words (views/orchestra.ts and its rows in the model picker,
// views/chat-models.ts). Windows-only strings: their translations are in
// src/i18n/extra.json.

import { N_ } from "../i18n/i18n";

export const ORCHESTRA_STRINGS = {
  /** The picker's chip, as a provider's. */
  orchestra: N_("Orchestra"),
  coordinator: N_("Coordinator"),
  /** The picker's row for the threads' model. */
  thread: N_("Thread"),
  /** The rail's title over the threads (in capitals). */
  threads: N_("Threads"),
  pickerNote: N_("The coordinator doesn't touch files or use tools: it makes the plan, opens the threads, writes to them and answers you. Each thread is a chat with its own model and your tools, and can write to the coordinator and the other threads."),
  /** The coordinator's line in the rail while it works with no step to say. */
  planning: N_("Planning"),
  /** The coordinator's line once every thread is done. */
  finished: N_("finished"),
  /** A thread done: how long it took. */
  finishedIn: N_("Finished in {time}"),
  done: N_("Finished"),
  working: N_("At work"),
  waiting: N_("Waiting for you"),
  idle: N_("Waiting"),
  queued: N_("Queued"),
  failed: N_("Failed"),
  stopped: N_("Stopped"),
  /** A thread the coordinator just opened, not looked at yet. */
  fresh: N_("Just opened"),
  thinking: N_("Thinking…"),
  planPill: N_("Plan {done}/{total}"),
  /** A thread's own list of steps. */
  listPill: N_("List {done}/{total}"),
  planTitle: N_("The plan"),
  planDone: N_("{done} of {total} done"),
  stopAll: N_("Stop all"),
  stopOne: N_("Stop thread"),
  fromCoordinator: N_("From the coordinator"),
  from: N_("From {name}"),
  to: N_("To {name}"),
  toCoordinator: N_("To the coordinator"),
  asks: N_("{name} asks you"),
  answerThere: N_("Or answer in the thread"),
  answerBelow: N_("Or write your answer below"),
  recommended: N_("Recommended"),
  lockLabel: N_("Lumo · file already in use"),
  /** In the chat of the member that tried to change the file. */
  lockMine: N_("{holder} is changing {path}: your change was not made. Send them your part, or ask the coordinator."),
  /** In the coordinator's chat. */
  lockOther: N_("{name} wanted to change {path}, but {holder} is working on it. Lumo kept it from doing so and told it."),
  started: N_("Opened the thread {name}"),
  readMidTurn: N_("Read while it worked"),
  queuedLine: N_("Queued: arrives at its next step"),
  nextStep: N_("At the next step"),
  writeCoordinator: N_("Write to the coordinator…"),
  writeTo: N_("Write to {name}…"),
  locksTitle: N_("Who holds which files"),
  locksBy: N_("updated by Lumo"),
  newOrchestra: N_("New orchestra"),
  orchestras: N_("Orchestras"),
  untitled: N_("New orchestra"),
  notSent: N_("Not sent: {error}"),
  showInFolder: N_("Show in folder"),
  close: N_("Close"),
};
