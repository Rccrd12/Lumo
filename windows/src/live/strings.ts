// Gemini Live — what the call view, the tools and Settings → Voice say.

import { N_ } from "../i18n/i18n";

export const LIVE_STRINGS = {
  talk: N_("Talk with Gemini Live"),
  start: N_("Start talking"),
  intro: N_("Talk with Gemini as you work. It can look at your screen, read your files and PDFs, open files and apps, and ask {helper} for what it can't do."),
  introNoScreen: N_("Talk with Gemini as you work. It can read your files and PDFs, open files and apps, and ask {helper} for what it can't do."),
  connecting: N_("Connecting…"),
  reconnecting: N_("Reconnecting…"),
  listening: N_("Listening"),
  speaking: N_("Speaking"),
  thinking: N_("Thinking…"),
  muted: N_("Microphone off"),
  mute: N_("Turn the microphone off"),
  unmute: N_("Turn the microphone on"),
  end: N_("End call"),
  typeHere: N_("Or type to Gemini…"),
  extendedThinking: N_("Extended Thinking: thinks longer before it answers"),
  send: N_("Send"),
  endedSilence: N_("The call ended after 5 minutes of silence."),
  openSettings: N_("Open Settings"),
  // The microphone
  micDenied: N_("Lumo can't use the microphone. Allow it in the system's privacy settings, then try again."),
  micMissing: N_("No microphone was found."),
  micFailed: N_("The microphone couldn't be opened."),
  // The connection
  lost: N_("The connection to Gemini Live was lost."),
  closedBecause: N_("Gemini Live ended the call: {detail}"),
  quota: N_("Google refused the call: it says this key's quota for {model} is used up. Its limits are in Google AI Studio, under Rate limit."),
  // What the model is doing
  lookingLumo: N_("Looking at what Lumo knows"),
  lookingWindows: N_("Looking at the open windows"),
  lookingExplorer: N_("Looking at the folder open in File Explorer"),
  lookingScreen: N_("Looking at the screen"),
  reading: N_("Reading {name}"),
  searchingFor: N_("Searching for {pattern}"),
  opening: N_("Opening {name}"),
  typing: N_("Typing the text"),
  asked: N_("Asked {helper}"),
  helperDone: N_("{helper} answered"),
  helperStopped: N_("{helper} stopped"),
};

/** Settings → Voice. */
export const VOICE_SETTINGS = {
  page: N_("Voice"),
  hint: N_("Talk with Gemini from the island, with the microphone next to the chat box or {keys}. It answers out loud, looks at your screen when that helps and hands the rest to the helper below. It uses your Google AI key, billed by the minute; a call ends after 5 minutes of silence."),
  key: N_("Google AI key"),
  model: N_("Model"),
  thinking: N_("Thinking"),
  thinkingHint: N_("How long Gemini reasons in the background while it talks. Higher is smarter on hard questions, and slower."),
  voice: N_("Voice"),
  automatic: N_("Automatic"),
  screen: N_("Gemini can look at the screen"),
  screenHint: N_("It takes a screenshot only when it decides it needs one, and only during a call. Nothing is kept: the picture goes to Google and is deleted from this computer."),
  helper: N_("Helper"),
  helperHint: N_("The agent Gemini hands what it can't do itself. It follows the chat's permissions: anything else is a card in the island for you to allow or deny."),
  helperModel: N_("Helper's model"),
  helperEffort: N_("Helper's effort"),
};
