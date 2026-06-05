# Gram One

A lightweight, modular AI assistant platform built with Node.js.

Gram One is designed around a simple idea: an assistant should be easy to run, easy to extend, and capable of growing with your needs. Instead of being a monolithic application, every part of Gram One is built to be modular, allowing new capabilities, integrations, and workflows to be added over time.

Whether you're connecting multiple LLM providers, integrating MCP servers, experimenting with retrieval systems, or building custom agent workflows, Gram One provides a clean foundation to build on.

---

## Features

### Multi-Provider Model Support

Use models from virtually any provider by configuring the backend you prefer.

* OpenAI-compatible APIs
* Local models
* Self-hosted providers
* Cloud providers
* Easily extendable provider architecture

---

### Profiles (System Prompts)

Profiles are reusable system prompts that define how the assistant behaves.

Profiles can dramatically alter:

* Personality
* Expertise
* Response style
* Tool usage
* Workflow behavior

Switching profiles effectively creates a completely different assistant experience without changing models.

---

### Persistent Chat History

All conversations are stored and can be revisited later.

* Conversation persistence
* Historical context access
* Foundation for future memory systems

---

### Lightweight Fact Memory

Gram One includes a lightweight fact system powered by retrieval.

Facts can be stored and recalled across chats when relevant.

Examples:

* Where your car keys are
* Important reminders
* Preferences
* Personal notes
* Project-specific information

This is intentionally **not** a full long-term memory system. Instead, it focuses on storing useful facts and retrieving them when needed through RAG.

---

### MCP Server Support

Gram One works with MCP servers and can leverage tools exposed through them.

Compatible with:

https://github.com/aleee-dev1/mcp-servers

The architecture is designed to remain flexible and should work with other MCP servers as well.

---

### Live Token Usage

Monitor token usage in real time while chatting.

Useful for:

* Cost tracking
* Prompt optimization
* Model comparison
* Development workflows

---

### Modular Architecture

The entire project is built around extensibility.

Current capabilities are only the starting point.

New systems can be added without redesigning the application:

* Additional providers
* Advanced memory systems
* Agent workflows
* Tool ecosystems
* Automation pipelines
* Custom integrations
* New UI components

---

## Philosophy

Gram One is not trying to be a fixed AI application.

It is a foundation for building assistants.

Every component is designed with future expansion in mind, allowing the project to evolve from a lightweight chat interface into a highly capable assistant platform without requiring major architectural changes.

---

## Planned Directions

Potential future expansions include:

* Full long-term memory systems
* Agent loops
* Multi-agent workflows
* Advanced knowledge management
* Improved retrieval systems
* Custom plugin ecosystem
* Enhanced automation capabilities

The goal is to keep the core lightweight while allowing capabilities to scale as needed.

---

## Technology

* Node.js
* SQLite
* Retrieval-Augmented Generation (RAG)
* MCP (Model Context Protocol)
* Modular provider architecture

---

## Getting Started

```bash
git clone <repository-url>
cd gram-one

npm install

npm start
```

Configure your preferred model provider and start chatting.

---

## Project Status

Active development.

New features and modules are added incrementally while maintaining a lightweight core architecture.

---

## License

MIT

