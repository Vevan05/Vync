const {createClient} = require("redis");

const client = createClient({
    url: process.env.REDIS_URl || "redis://localhost:6379"
});

client.on("error", (err) =>{console.error("Redis Error: ", err)});

async function connect() {
    if(!client.isOpen) await client.connect();
}

async function addUserToRoom(roomId, socketId, userData) {
  await connect();
  await client.hSet(`room:${roomId}`, socketId, JSON.stringify(userData));

  await client.expire(`room:${roomId}`, 86400);
}

async function removeUserFromRoom(roomId, socketId) {
  await connect();
  await client.hDel(`room:${roomId}`, socketId);
}

async function getRoomUsers(roomId) {
  await connect();
  const data = await client.hGetAll(`room:${roomId}`);
  return Object.entries(data).map(([socketId, raw]) => {
    const parsed = JSON.parse(raw);
    return { socketId, name: parsed.name, color: parsed.color };
  });
}

async function deleteRoom(roomId) {
  await connect();
  await client.del(`room:${roomId}`);
}

module.exports = { addUserToRoom, removeUserFromRoom, getRoomUsers, deleteRoom };