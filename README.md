# tasker-effect

TypeScript library for managing [Tasker](https://tasker.joaoapps.com/) profiles using [Effect 4](https://effect.website/).

> Define, compile, and sync Tasker automations with type safety and functional programming patterns.

## Features

- 🔒 **Type-safe API bindings** - Full TypeScript types for all Tasker JavaScript functions
- 📝 **Profile DSL** - Effect Schema-based domain language for defining profiles, tasks, and actions
- 🔄 **Compiler** - Transform TypeScript definitions into Tasker-importable XML files
- ☁️ **CI Sync** - Pull compiled profiles from GitHub Actions artifacts
- 🧪 **Testable** - Mock implementations for testing without a device

## Installation

```bash
bun add tasker-effect
# or
npm install tasker-effect
```

## Quick Start

```typescript
import { Effect } from "effect";
import {
  profile, task, time, wifi,
  flash, setVar, performTask,
  compileProfileToXml
} from "tasker-effect";

// Define a task
const morningTask = task("Morning Routine", [
  flash("Good morning!"),
  setVar("%MODE", "morning"),
  performTask("Enable Work Apps"),
]);

// Define a profile with time trigger
const morningProfile = profile(
  "Morning Mode",
  [time({ hour: 7, minute: 0 }, { to: { hour: 9, minute: 0 } })],
  morningTask
);

// Compile to Tasker XML
const program = compileProfileToXml(morningProfile);
const outputs = await Effect.runPromise(program);

outputs.forEach(output => {
  console.log(`${output.filename}:`);
  console.log(output.content);
});
```

## Triggers

### Time Trigger

```typescript
import { time } from "tasker-effect";

// Simple time
time({ hour: 9, minute: 0 });

// Time range
time({ hour: 9, minute: 0 }, { to: { hour: 17, minute: 0 } });

// With day filtering
time({ hour: 9, minute: 0 }, {
  days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
});

// Repeating
time({ hour: 9, minute: 0 }, { repeatMinutes: 30 });
```

### WiFi Trigger

```typescript
import { wifi } from "tasker-effect";

// Connected to specific network
wifi({ ssid: "MyNetwork" });

// Disconnected
wifi({ ssid: "MyNetwork", connected: false });

// Any network
wifi();
```

### Bluetooth Trigger

```typescript
import { bluetooth } from "tasker-effect";

// Connected to device
bluetooth({ name: "Car Stereo" });

// By address
bluetooth({ address: "AA:BB:CC:DD:EE:FF" });
```

### Battery Trigger

```typescript
import { battery } from "tasker-effect";

// Low battery (0-20%)
battery(0, 20);

// Full battery (80-100%)
battery(80, 100);
```

### App Trigger

```typescript
import { app } from "tasker-effect";

// By package name
app("com.spotify.music");

// By label
app("Spotify");
```

### Variable Trigger

```typescript
import { variable } from "tasker-effect";

variable("%DEBUG", "equals", "true");
variable("%COUNTER", "greater_than", "10");
variable("%FLAG", "is_set");
```

## Actions

### Alert Actions

```typescript
import { flash, PopupAction, SayAction, VibrateAction, NotifyAction } from "tasker-effect";

// Flash message
flash("Hello!");
flash("Hello!", true); // Long flash

// TTS
new SayAction({ text: "Hello world", pitch: 5, speed: 5 });

// Vibrate
new VibrateAction({ duration: 500 });

// Notification
new NotifyAction({
  title: "Alert",
  text: "Something happened",
  priority: "high",
});
```

### Variable Actions

```typescript
import { setVar, ClearVariableAction, VariableAddAction } from "tasker-effect";

// Set variable
setVar("%myvar", "value");

// With math
setVar("%counter", "%counter + 1", { doMaths: true });

// Clear
new ClearVariableAction({ name: "%myvar" });

// Add
new VariableAddAction({ name: "%counter", value: 5 });
```

### Task Control

```typescript
import { performTask, wait, StopAction, ReturnAction, GotoAction } from "tasker-effect";

// Run another task
performTask("Other Task");
performTask("Other Task", { param1: "arg1", param2: "arg2" });

// Wait
wait({ seconds: 5 });
wait({ milliseconds: 500 });

// Stop
new StopAction({ withError: false });

// Return value
new ReturnAction({ value: "result" });

// Goto
new GotoAction({ target: { type: "label", label: "MyLabel" } });
new GotoAction({ target: { type: "action", number: 5 } });
new GotoAction({ target: { type: "end" } });
```

### Control Flow

```typescript
import { IfAction, ElseAction, EndIfAction, ForAction, EndForAction } from "tasker-effect";

// If-Else-EndIf
new IfAction({ lhs: "%var", operator: "eq", rhs: "value" });
new ElseAction({});
new EndIfAction({});

// For loop
new ForAction({ variable: "%item", items: "%array" });
new EndForAction({});
```

### Network Actions

```typescript
import { http, BrowseUrlAction, SendSmsAction } from "tasker-effect";

// HTTP request
http("GET", "https://api.example.com/data");
http("POST", "https://api.example.com/data", {
  body: JSON.stringify({ key: "value" }),
  headers: { "Content-Type": "application/json" },
  outputVariable: "%response",
});

// Open URL
new BrowseUrlAction({ url: "https://example.com" });

// Send SMS
new SendSmsAction({ number: "+1234567890", message: "Hello!" });
```

### Shell Actions

```typescript
import { shell, ShellAction } from "tasker-effect";

// Basic shell command
shell("echo hello");

// With root
shell("settings put system...", { root: true });

// With timeout
shell("long-running-command", { timeout: 120 });
```

### JavaScript Actions

```typescript
import { javascriptlet, JavaScriptAction } from "tasker-effect";

// Inline JavaScript
javascriptlet(`
  var x = 1 + 1;
  setGlobal('result', x);
`);

// From file
new JavaScriptAction({ path: "/sdcard/scripts/myscript.js" });
```

## Compilation

### Compile Task

```typescript
import { task, flash, compileTaskToXml } from "tasker-effect";
import { Effect } from "effect";

const myTask = task("My Task", [flash("Hello!")]);

const xml = await Effect.runPromise(compileTaskToXml(myTask));
console.log(xml); // Outputs .tsk.xml content
```

### Compile Profile

```typescript
import { profile, time, task, flash, compileProfileToXml } from "tasker-effect";
import { Effect } from "effect";

const myProfile = profile(
  "My Profile",
  [time({ hour: 9, minute: 0 })],
  task("Entry", [flash("Activated!")])
);

const outputs = await Effect.runPromise(compileProfileToXml(myProfile));
// outputs: Array<{ filename, content, type }>
```

### Compile Project

```typescript
import { project, compileProjectToXml } from "tasker-effect";
import { Effect } from "effect";

const myProject = project("My Project", {
  profiles: [/* ... */],
  tasks: [/* ... */],
});

const xml = await Effect.runPromise(compileProjectToXml(myProject));
console.log(xml); // Outputs .prj.xml content
```

## Syncing from CI

Pull compiled profiles from GitHub Actions artifacts:

```typescript
import { pullLatestProfiles } from "tasker-effect";
import { Effect } from "effect";

const result = await Effect.runPromise(
  pullLatestProfiles({
    owner: "your-username",
    repo: "your-repo",
    token: process.env.GITHUB_TOKEN,
    targetDir: "./profiles",
  })
);

console.log(`Downloaded ${result.files.length} files`);
```

## Tasker API Bindings

Use Tasker's JavaScript API with full type safety:

```typescript
import { Tasker, TaskerLive, TaskerMock } from "tasker-effect";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  
  // Flash a message
  yield* tasker.flash("Hello from Effect!");
  
  // Get a global variable
  const value = yield* tasker.global("MY_VAR");
  
  // Set a variable
  yield* tasker.setGlobal("RESULT", "done");
  
  // Check if on device
  const onDevice = yield* tasker.isOnDevice();
});

// Run on device with real Tasker
Effect.runPromise(program.pipe(Effect.provide(TaskerLive)));

// Run in tests with mock
Effect.runPromise(program.pipe(Effect.provide(TaskerMock)));
```

## CI/CD Integration

The library includes a GitHub Actions workflow for:

1. Type checking
2. Running tests
3. Building the library
4. Compiling profiles to XML
5. Uploading artifacts

See `.github/workflows/ci.yml` for the full workflow.

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Run tests
bun test

# Build
bun run build

# Compile example profiles
bun run scripts/compile-profiles.ts
```

## File Format Reference

Tasker uses XML files with specific extensions:

| Extension | Type | Import Location |
|-----------|------|-----------------|
| `.tsk.xml` | Task | TASKS tab → Import Task |
| `.prf.xml` | Profile | PROFILES tab → Import Profile |
| `.prj.xml` | Project | Project bar → Import Project |

## License

MIT
