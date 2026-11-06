// Lumo's chat with a model server on this machine (Ollama, LM Studio, Unsloth
// Studio, or any server that speaks the OpenAI API): reading the answer as it
// streams in, the rounds of tool calls, and the checks that catch what local
// models get wrong. Nothing here knows the app: it is driven by the app
// (src-tauri/src/local_chat.rs) through `turn::Hooks`, so all of it runs
// against a fake server in the tests, on any system.

pub mod guard;
pub mod native;
pub mod sse;
pub mod transport;
pub mod turn;

pub use transport::{Answer, Endpoint, Failure};
pub use turn::{run, Doing, End, Hooks, Loaded, Outcome, Rules, MORE};
