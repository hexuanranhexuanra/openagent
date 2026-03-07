import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MessageQueue } from "../message-queue";
import { ChannelManager } from "../manager";
import { MockChannel } from "../mock";
import { GatewayAdapter } from "../gateway-adapter";
import type { InboundMessage, OutboundMessage } from "../../types";

// ─── MessageQueue ────────────────────────────────────────────────────────────

describe("MessageQueue", () => {
  let mq: MessageQueue;

  beforeEach(() => {
    mq = new MessageQueue();
  });

  test("publishInbound → consumeInbound returns the message", async () => {
    const msg: InboundMessage = {
      channelType: "mock",
      channelId: "chat-1",
      peerId: "user-1",
      content: "hello",
      timestamp: Date.now(),
    };

    mq.publishInbound(msg);
    const received = await mq.consumeInbound();
    expect(received).toEqual(msg);
  });

  test("publishOutbound → consumeOutbound returns the message", async () => {
    const msg: OutboundMessage = {
      channelType: "mock",
      channelId: "chat-1",
      peerId: "user-1",
      content: "reply",
    };

    mq.publishOutbound(msg);
    const received = await mq.consumeOutbound();
    expect(received).toEqual(msg);
  });

  test("waiter resolves when message is published after consume is called", async () => {
    const consumePromise = mq.consumeInbound();

    const msg: InboundMessage = {
      channelType: "mock",
      channelId: "chat-1",
      peerId: "user-1",
      content: "delayed",
      timestamp: Date.now(),
    };

    // Publish after a tick
    setTimeout(() => mq.publishInbound(msg), 5);

    const received = await consumePromise;
    expect(received?.content).toBe("delayed");
  });

  test("multiple messages are buffered and consumed in order (FIFO)", async () => {
    const messages = ["a", "b", "c"];
    for (const content of messages) {
      mq.publishInbound({ channelType: "mock", channelId: "c", peerId: "u", content, timestamp: Date.now() });
    }

    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await mq.consumeInbound();
      if (m) results.push(m.content);
    }

    expect(results).toEqual(messages);
  });

  test("stop() unblocks a pending consumer with null", async () => {
    const consumePromise = mq.consumeInbound();
    mq.stop();
    const result = await consumePromise;
    expect(result).toBeNull();
  });

  test("publishInbound after stop() is a no-op", () => {
    mq.stop();
    mq.publishInbound({ channelType: "mock", channelId: "c", peerId: "u", content: "x", timestamp: Date.now() });
    expect(mq.inboundSize).toBe(0);
  });

  test("inboundSize and outboundSize reflect buffer lengths", () => {
    expect(mq.inboundSize).toBe(0);
    mq.publishInbound({ channelType: "mock", channelId: "c", peerId: "u", content: "x", timestamp: Date.now() });
    mq.publishInbound({ channelType: "mock", channelId: "c", peerId: "u", content: "y", timestamp: Date.now() });
    expect(mq.inboundSize).toBe(2);
  });
});

// ─── MockChannel ─────────────────────────────────────────────────────────────

describe("MockChannel", () => {
  test("send() captures messages in sentMessages", async () => {
    const ch = new MockChannel();
    await ch.start();

    await ch.send({ channelType: "mock", channelId: "c", peerId: "u", content: "hi" });
    await ch.send({ channelType: "mock", channelId: "c", peerId: "u", content: "bye" });

    expect(ch.sentMessages).toHaveLength(2);
    expect(ch.sentMessages[0].content).toBe("hi");
    expect(ch.sentMessages[1].content).toBe("bye");
  });

  test("simulateIncoming() triggers the registered handler", async () => {
    const ch = new MockChannel();
    const received: string[] = [];

    ch.onMessage(async (msg) => {
      received.push(msg.content);
    });

    await ch.simulateIncoming("test message", "user-x");
    expect(received).toEqual(["test message"]);
  });

  test("simulateIncoming() without handler does not throw", async () => {
    const ch = new MockChannel();
    await expect(ch.simulateIncoming("msg")).resolves.toBeUndefined();
  });

  test("clearSent() empties sentMessages", async () => {
    const ch = new MockChannel();
    await ch.send({ channelType: "mock", channelId: "c", peerId: "u", content: "x" });
    ch.clearSent();
    expect(ch.sentMessages).toHaveLength(0);
  });
});

// ─── ChannelManager ──────────────────────────────────────────────────────────

describe("ChannelManager", () => {
  test("register() routes inbound messages to onMessage handler", async () => {
    const manager = new ChannelManager();
    const ch = new MockChannel();
    manager.register(ch);

    const received: string[] = [];
    manager.onMessage(async (msg) => {
      received.push(msg.content);
    });

    await ch.simulateIncoming("from channel");
    expect(received).toEqual(["from channel"]);
  });

  test("startOutboundDispatch() routes outbound to the correct channel.send()", async () => {
    const manager = new ChannelManager();
    const ch = new MockChannel();
    manager.register(ch);

    const mq = new MessageQueue();
    manager.startOutboundDispatch(mq);

    mq.publishOutbound({
      channelType: "mock",
      channelId: "c",
      peerId: "u",
      content: "routed reply",
    });

    // Give the dispatch loop one tick to process
    await new Promise((r) => setTimeout(r, 10));

    expect(ch.sentMessages).toHaveLength(1);
    expect(ch.sentMessages[0].content).toBe("routed reply");

    mq.stop();
  });

  test("outbound message to unknown channel is dropped without throwing", async () => {
    const manager = new ChannelManager();
    const mq = new MessageQueue();
    manager.startOutboundDispatch(mq);

    // No channel registered for "unknown"
    mq.publishOutbound({ channelType: "unknown", channelId: "c", peerId: "u", content: "x" });

    await new Promise((r) => setTimeout(r, 10));
    // No error thrown — just verify we get here
    mq.stop();
  });

  test("startAll / stopAll calls channel lifecycle methods", async () => {
    const manager = new ChannelManager();
    const ch = new MockChannel();
    manager.register(ch);

    await manager.startAll();
    await manager.stopAll();
    // No errors thrown
  });
});

// ─── GatewayAdapter ──────────────────────────────────────────────────────────

describe("GatewayAdapter", () => {
  // Mock runAgent to avoid real LLM calls
  beforeEach(() => {
    mock.module("../../agent", () => ({
      runAgent: async function* (channel: string, peerId: string, content: string) {
        yield { type: "text", content: `echo:${content}` };
        yield { type: "done" };
      },
      initAgent: () => {},
    }));
  });

  test("processes an inbound message and publishes to outbound queue", async () => {
    const mq = new MessageQueue();
    const adapter = new GatewayAdapter();

    // Start adapter in background
    adapter.start(mq);

    mq.publishInbound({
      channelType: "mock",
      channelId: "chat-1",
      peerId: "user-1",
      content: "ping",
      timestamp: Date.now(),
    });

    const outbound = await Promise.race([
      mq.consumeOutbound(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);

    adapter.stop();
    mq.stop();

    expect(outbound).not.toBeNull();
    expect(outbound?.content).toBe("echo:ping");
    expect(outbound?.channelType).toBe("mock");
    expect(outbound?.peerId).toBe("user-1");
  });

  test("passes raw.messageId as replyToId on outbound message", async () => {
    const mq = new MessageQueue();
    const adapter = new GatewayAdapter();

    adapter.start(mq);

    mq.publishInbound({
      channelType: "feishu",
      channelId: "chat-1",
      peerId: "ou_abc",
      content: "hello",
      timestamp: Date.now(),
      raw: { messageId: "feishu-msg-999" },
    });

    const outbound = await Promise.race([
      mq.consumeOutbound(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);

    adapter.stop();
    mq.stop();

    expect(outbound?.replyToId).toBe("feishu-msg-999");
  });

  test("two concurrent users are processed in parallel (different session keys)", async () => {
    const mq = new MessageQueue();
    const adapter = new GatewayAdapter();

    adapter.start(mq);

    mq.publishInbound({ channelType: "mock", channelId: "c", peerId: "user-A", content: "msgA", timestamp: Date.now() });
    mq.publishInbound({ channelType: "mock", channelId: "c", peerId: "user-B", content: "msgB", timestamp: Date.now() });

    const results: string[] = [];
    for (let i = 0; i < 2; i++) {
      const msg = await Promise.race([
        mq.consumeOutbound(),
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);
      if (msg) results.push(msg.peerId);
    }

    adapter.stop();
    mq.stop();

    expect(results.sort()).toEqual(["user-A", "user-B"]);
  });

  test("stop() prevents further processing", async () => {
    const mq = new MessageQueue();
    const adapter = new GatewayAdapter();

    adapter.start(mq);
    adapter.stop();
    mq.stop();

    // After stop, no sessions should be active
    expect(adapter.getActiveSessions()).toHaveLength(0);
  });
});
