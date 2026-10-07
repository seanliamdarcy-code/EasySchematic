import {test} from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {WebSocket} from "ws";
import {AppBridge} from "./bridge.js";
test("bridge rejects foreign origins and wrong tokens, relays commands and rejects on disconnect", async () => {
  const bridge=new AppBridge({port:0,token:"fixture-token",allowedOrigins:["https://testschematic.tateside.online"],log:()=>{}});
  bridge.start();
  const server=bridge["wss"]!;
  await once(server,"listening");
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
