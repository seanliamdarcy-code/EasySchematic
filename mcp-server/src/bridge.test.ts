import {test} from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {WebSocket} from "ws";
import {AppBridge} from "./bridge.js";
test("bridge rejects foreign origins and wrong tokens, relays commands and rejects on disconnect", async () => {
  const bridge=new AppBridge({port:0,token:"fixture-token",allowedOrigins:["https://testschematic.tateside.online"],log:()=>{}});
  await bridge.start();
  const server=bridge["wss"]!;
  const address=server.address(); assert.ok(address && typeof address !== "string");
  const url=`ws://127.0.0.1:${address.port}`;
  const sockets:WebSocket[]=[];
  try {
    for (const [origin,token] of [["https://schematic.tateside.online","fixture-token"],["https://testschematic.tateside.online","wrong"]]) {
      const socket=new WebSocket(url,{origin}); sockets.push(socket);
      const closed=once(socket,"close");
      socket.on("open",()=>socket.send(JSON.stringify({type:"hello",token,protocolVersion:1,clientId:"fixture"})));
      await closed; assert.equal(bridge.connected,false);
    }
    const socket=new WebSocket(url,{origin:"https://testschematic.tateside.online"}); sockets.push(socket);
    await once(socket,"open");
    const hello=once(socket,"message");
    socket.send(JSON.stringify({type:"hello",token:"fixture-token",protocolVersion:1,clientId:"fixture"}));
    assert.equal(JSON.parse(String((await hello)[0])).ok,true);
    const command=once(socket,"message"); const result=bridge.call("get_schematic",{});
    const message=JSON.parse(String((await command)[0]));
    socket.send(JSON.stringify({type:"response",requestId:message.requestId,ok:true,result:{deviceCount:0}}));
    assert.deepEqual(await result,{deviceCount:0});
    const pending=bridge.call("get_schematic",{}); const rejected=assert.rejects(pending,/disconnected/);
    socket.close(); await rejected;
  } finally { for(const socket of sockets) socket.terminate(); bridge.stop(); }
});

test("multiple MCP sessions share one authenticated editor and preserve response correlation", async () => {
  const options = {port:0,token:"fixture-token",allowedOrigins:["https://testschematic.tateside.online"],log:()=>{}};
  const owner = new AppBridge(options);
  await owner.start();
  const address = owner["wss"]!.address(); assert.ok(address && typeof address !== "string");
  const second = new AppBridge({...options,port:address.port});
  const third = new AppBridge({...options,port:address.port});
  const wrongToken = new AppBridge({...options,port:address.port,token:"wrong"});
  const editor = new WebSocket(`ws://127.0.0.1:${address.port}`,{origin:"https://testschematic.tateside.online"});
  const opened = once(editor,"open");
  try {
    await Promise.all([second.start(),third.start(),wrongToken.start()]);
    await opened;
    const hello = once(editor,"message");
    editor.send(JSON.stringify({type:"hello",token:options.token,protocolVersion:1}));
    assert.equal(JSON.parse(String((await hello)[0])).ok,true);
    editor.on("message",data => {
      const message = JSON.parse(String(data));
      assert.equal(message.type,"command");
      setTimeout(() => editor.send(JSON.stringify({type:"response",requestId:message.requestId,ok:message.command !== "fail",result:message.params,error:"fixture failure"})),message.params.delay ?? 0);
    });
    assert.deepEqual(await Promise.all([
      owner.call("get_schematic",{chat:1,delay:20}),
      second.call("get_schematic",{chat:2,delay:10}),
      third.call("get_schematic",{chat:3}),
    ]),[{chat:1,delay:20},{chat:2,delay:10},{chat:3}]);
    await assert.rejects(wrongToken.call("get_schematic",{}),/Invalid pairing token/);
    assert.equal(owner.connected,true);
    await assert.rejects(second.call("fail",{}),/fixture failure/);
    const closed = once(editor,"close"); editor.close(); await closed;
    await assert.rejects(third.call("get_schematic",{}),/No EasySchematic app is connected/);
  } finally {
    editor.terminate(); second.stop(); third.stop(); wrongToken.stop(); owner.stop();
  }
});
