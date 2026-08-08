# tasker-effect

Manage and program Tasker profiles in TypeScript using Effect 4.

## Features

- **TypeScript-first**: Write Tasker profiles with full type safety using TypeScript 7
- **Effect ecosystem**: Built on Effect 4 for robust error handling and composability
- **Self-updating**: Pull latest compiled profiles directly from CI to your device
- **Tasker API bindings**: Type-safe wrappers for Tasker's JavaScript API

## Requirements

- Bun 1.3+
- TypeScript 7.0+
- Tasker (Android) with JavaScript support enabled

## Installation

```bash
bun install
```

## Usage

```typescript
import { TaskerProfile, TaskerTask } from "tasker-effect";

// Define a profile
const myProfile = TaskerProfile.make({
  name: "Morning Routine",
  triggers: [{ type: "time", hour: 7, minute: 0 }],
  tasks: [
    TaskerTask.notification({ title: "Good morning!", text: "Time to wake up" }),
    TaskerTask.setVolume({ stream: "media", level: 50 }),
  ],
});
```

## Pull Updates from CI

The package includes a self-update mechanism that can pull the latest compiled profiles from GitHub Actions directly on your device:

```typescript
import { pullLatestProfiles } from "tasker-effect/sync";

// Pull and apply latest profiles
await pullLatestProfiles();
```

## Tasker JavaScript API

This package provides TypeScript bindings for Tasker's public JavaScript API. See [Tasker JS API Documentation](https://tasker.joaoapps.com/userguide/en/javascript.html).

## Development

```bash
# Run tests
bun test

# Build
bun run build

# Type check
bun run typecheck
```

## License

MIT
