import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "/home/syhekate/Lumiverse/src/macros/MacroEvaluator";
import { parse } from "/home/syhekate/Lumiverse/src/macros/MacroParser";
import { registry } from "/home/syhekate/Lumiverse/src/macros/MacroRegistry";
import { withJsonBlocksProtected } from "/home/syhekate/Lumiverse/src/macros/json-blocks";
import { initMacros, withPromptBlockContext } from "/home/syhekate/Lumiverse/src/macros/index";
import type { MacroEnv } from "/home/syhekate/Lumiverse/src/macros/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEnv(opts: {
  localVars?: Record<string, string>;
  globalVars?: Record<string, string>;
  chatVars?: Record<string, string>;
  messages?: { content: string; name: string; is_user: boolean }[];
  characterTags?: string[];
  chatCreatedAt?: number;
  lastMessageTime?: number;
  worldInfoOutlets?: Record<string, string>;
  personaAddonOutlets?: Record<string, string>;
  rejectedSwipe?: string;
  userInput?: string;
  promptBlock?: MacroEnv["promptBlock"];
  multiplayer?: {
    playerCount: number;
    playerNames: string[];
    hostName: string;
    currentTurnName: string;
    turnStrategy: string;
  };
} = {}): MacroEnv {
  const env: MacroEnv = {
    commit: true,
    names: {
      user: "Alice",
      char: "Bob",
      group: "Bob, Charlie, Dave",
      groupNotMuted: "Bob, Charlie",
      notChar: "Alice",
      charGroupFocused: "Bob",
      groupOthers: "Charlie, Dave",
      groupMemberCount: "3",
      isGroupChat: "yes",
      isNarrator: "no",
      groupLastSpeaker: "Charlie",
      groupCardMode: "swap",
    },
    character: {
      name: "Bob",
      description: "A brave warrior with a heart of gold",
      personality: "Courageous and kind",
      scenario: "In a fantasy kingdom",
      persona: "I am Alice, a mage",
      personaSubjectivePronoun: "she",
      personaObjectivePronoun: "her",
      personaPossessivePronoun: "her",
      personaReflexivePronoun: "herself",
      personaPossessivePronounStandalone: "hers",
      mesExamples: "<START>\n{{user}}: Hi\n{{char}}: Hello!",
      mesExamplesRaw: "<START>\n{{user}}: Hi\n{{char}}: Hello!",
      systemPrompt: "You are Bob.",
      postHistoryInstructions: "Stay in character.",
      depthPrompt: "",
      creatorNotes: "Test character",
      version: "1.0",
      creator: "Tester",
      firstMessage: "Greetings, adventurer!",
    },
    chat: {
      id: "chat-123",
      messageCount: 5,
      lastMessage: "The dragon approaches!",
      lastMessageName: "Bob",
      lastUserMessage: "I draw my sword.",
      lastCharMessage: "The dragon approaches!",
      lastMessageId: 4,
      firstIncludedMessageId: 0,
      lastSwipeId: 0,
      currentSwipeId: 0,
      rejectedSwipe: opts.rejectedSwipe ?? "",
    },
    system: {
      model: "gpt-4",
      maxPrompt: 4096,
      maxContext: 8192,
      maxResponse: 2048,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(Object.entries(opts.localVars ?? {})),
      global: new Map(Object.entries(opts.globalVars ?? {})),
      chat: new Map(Object.entries(opts.chatVars ?? {})),
    },
    dynamicMacros: {},
    promptBlock: opts.promptBlock,
    extra: {
      messages: opts.messages ?? [
        { content: "Hello, how are you?", name: "Alice", is_user: true },
        { content: "I'm fine, thanks!", name: "Bob", is_user: false },
        { content: "Let's go on an adventure.", name: "Alice", is_user: true },
        { content: "The forest is dark.", name: "Bob", is_user: false },
        { content: "I draw my sword.", name: "Alice", is_user: true },
      ],
      chatCreatedAt: opts.chatCreatedAt ?? Math.floor(Date.now() / 1000) - 3600,
      lastMessageTime: opts.lastMessageTime,
      characterTags: opts.characterTags ?? ["fantasy", "warrior", "male"],
      worldInfoOutlets: opts.worldInfoOutlets ?? {},
      personaAddonOutlets: opts.personaAddonOutlets ?? {},
      userInput: opts.userInput ?? "",
      ...(opts.multiplayer ? { multiplayer: opts.multiplayer } : {}),
    },
  };
  return env;
}

async function ev(template: string, env?: MacroEnv): Promise<string> {
  const result = await evaluate(template, env ?? makeEnv(), registry);
  return result.text;
}
beforeAll(() => { initMacros(); });
const wrap = (c: string, names: string[]) => names.map(n => `{{if::{{char}}==${n}}}${c}{{/if}}`).join("");
describe("knownBy emulation", () => {
  const body = "비밀: 하나는 사실 왕녀다";
  test("matching speaker sees it", async () => { const env = makeEnv(); env.names.char = "하나"; expect(await ev(wrap(body, ["하나","민수"]), env)).toBe(body); });
  test("other speaker sees nothing", async () => { const env = makeEnv(); env.names.char = "철수"; expect(await ev(wrap(body, ["하나","민수"]), env)).toBe(""); });
  test("tricky content", async () => { const c = "a == b :: {x} {{user}}"; const env = makeEnv(); env.names.char = "하나"; console.log("RAW", JSON.stringify(await ev(wrap(c, ["하나"]), env))); });
  test("name with space + english", async () => { const env = makeEnv(); env.names.char = "Mary Jane"; expect(await ev(wrap(body, ["Mary Jane"]), env)).toBe(body); });
});
