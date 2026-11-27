// The projects' words (views/orchestra.ts, views/projects.ts). Windows-only
// strings: their translations are in src/i18n/extra.json.

import { N_ } from "../i18n/i18n";

export const ORCHESTRA_STRINGS = {
  coordinator: N_("Coordinator"),
  /** The form's row for the threads' model. */
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
  /** The closed island: how many of the orchestra are at work (a plural, as the agents card's). */
  atWork: N_("{count} at work"),
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
  untitled: N_("New project"),
  notSent: N_("Not sent: {error}"),
  showInFolder: N_("Show in folder"),
  close: N_("Close"),
  /** A member stopped by a usage limit, until it goes on. */
  paused: N_("Paused"),
  /** In the rail: when a member stopped by a usage limit goes on. */
  resumesAt: N_("Goes on at {time}"),
  /** A usage limit stopped a member: the project goes on by itself at {time}. */
  limitResumes: N_("Usage limit reached: it goes on by itself at {time}."),
  limitStops: N_("Usage limit reached: write to it once the limits reset."),

  // ── The projects (views/projects.ts)
  projects: N_("Projects"),
  /** Under "Projects" on the empty chat's card. */
  projectsSub: N_("Several models work together on one goal"),
  /** The empty chat's card: how many projects (a plural). */
  projectCount: N_("{count} projects"),
  /** The empty chat's card: how many wait for the user (a plural). */
  waitingCount: N_("{count} waiting for you"),
  newProject: N_("New project"),
  noProjects: N_("No projects yet. In a project a coordinator and its threads, each with its own model, work together on what you ask."),
  /** A project not started yet. */
  ready: N_("Ready"),
  projectSettings: N_("Project settings"),
  allProjects: N_("All projects"),
  /** The way out of the projects, back to the chat. */
  chat: N_("Chat"),
  backToChats: N_("Back to the chats"),
  settings: N_("Settings"),
  nameAndIcon: N_("Name and icon"),
  namePlaceholder: N_("Project name"),
  goalQuestion: N_("What do you want to work on?"),
  goalPlaceholder: N_("The goal, what to keep to, how you want the work done…"),
  folder: N_("Folder"),
  folderNote: N_("Where the threads work. Without one, the project has its own."),
  pickFolder: N_("Choose a folder"),
  clearFolder: N_("No folder"),
  models: N_("Models"),
  effort: N_("Effort"),
  resumeLabel: N_("Continue the threads when the usage limits reset"),
  cancel: N_("Cancel"),
  create: N_("Create project"),
  save: N_("Save"),
  deleteProject: N_("Delete project"),
  /** Delete project, clicked once: a second click deletes it. */
  deleteSure: N_("Click again to delete it"),
  searchIcons: N_("Search icons"),
  noIcons: N_("No icon found"),
  noColor: N_("No color"),
  resetIcon: N_("Reset icon and color"),
  searchModels: N_("Search for a model"),
  noModels: N_("No model found"),
};
