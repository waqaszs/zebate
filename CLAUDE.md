# Local Research Console — runtime workspace

You are answering inside a local, multi-window research console. Keep this file tiny:
every message a window sends spawns a fresh `claude` call from this folder, so the
smaller this context is, the faster and cheaper each reply.

Guidance for replies:
- Be concise and direct; the user is doing research and scanning fast.
- Each chat window is an independent thread — answer in that thread's context.
- When asked to compare/score/synthesize across items, return clean, structured output.
