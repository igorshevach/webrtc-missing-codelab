const fs = require('fs');
const http = require('http');

const WebSocket = require('ws');
const uuid = require('uuid');
const {Janus} = require("./janus_utils");
const config = {
   servers: [
        {
            protocol: 'ws',
            sfuAddress: process.env.JANUS_IPV4_ADR || '127.0.0.1',
            sfuPort: 8188,
            rooms: [ {roomId: 777} ]
        },
    ]
};

const port = 8081;
 
// We use a HTTP server for serving static pages. In the real world you'll
// want to separate the signaling server and how you serve the HTML/JS, the
// latter typically through a CDN.
const server = http.Server({});

server.on('listening', () => {
    console.log('Server listening on http://localhost:' + port);
});
server.on('request', (request, response) => {
    fs.readFile('static/index.html', (err, data) => {
        if (err) {
            console.log('could not read client file', err);
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, {'Content-Type': 'text/html'});
        response.end(data);
    });
});


async function allocateRoom(config, roomId) {
    config = Array.isArray(config) ? config[0] : config;
    const janusServer = new Janus(`${config.protocol}://${config.sfuAddress}:${config.sfuPort}`);
    await janusServer.inited;
    return janusServer.createRoom(roomId);
}


allocateRoom(config.servers,777).then((room)=> {

    server.listen(port);
// A map of websocket connections.
    const connections = new Map();

    const getPublishers = ()=>{
        return Array.from(connections.values())
            .filter(h => typeof h.id === 'number' || !h.id.endsWith('-sub'))
            .map(p => p.id);
    };
// WebSocket server, running alongside the http server.
    const wss = new WebSocket.Server({server});

// Generate a (unique) client id.
// Exercise: extend this to generate a human-readable id.
    function generateClientId() {
        // TODO: enforce uniqueness here instead of below.
        return parseInt('0x' + uuid.v4().substring(0, 8));
    }


    let conTimer;
    wss.on('connection', async (ws) => {

        console.log('Received new connection');
        // Store the connection in our map of connections.
        const [publisher, subscriber] = await room.createClient(generateClientId());
        const id = publisher.id;
        console.log('connection assigned id ', id);


        subscriber.connection = ws;

        publisher.onclose = (reason) => {
            ws.close();
        }

        connections.set(publisher.id, publisher);
        connections.set(subscriber.id, subscriber);

        if (connections.size === 1) {
            conTimer = setInterval(() => {
                if (!connections.size)
                    clearInterval(conTimer);
                else
                    connections.forEach((c, id) =>
                        console.log(JSON.stringify({id: id, ...c.stats})));
            }, 5000);
        }

        // Send a greeting to tell the client its id.
        ws.send(JSON.stringify({
            type: 'hello',
            id,
        }));

        // Send an ice server configuration to the client. For stun this is synchronous,
        // for TURN it might require getting credentials.
        ws.send(JSON.stringify({
            type: 'iceServers',
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
        }));

        // Remove the connection. Note that this does not tell anyone you are currently in a call with
        // that this happened. This would require additional statekeeping that is not done here.
        ws.on('close', async () => {
            console.log(id, 'Connection closed');
            await publisher.unpublish();
            connections.delete(publisher.id);
            connections.delete(subscriber.id);
            if (!connections.size)
                clearInterval(conTimer);
        });

        let publishThrottleTimer;
        ws.on('message', async (message) => {

            //console.log(id, 'received', message);
            let data;
            // TODO: your protocol should send some kind of error back to the caller instead of
            // returning silently below.
            try {
                data = JSON.parse(message);
            } catch (err) {
                console.log(id, 'invalid json', err, message);
                return;
            }
            if (!data.id) {
                console.log(id, 'missing id', data);
                return;
            }

            const handler = connections.get(data.id);
            // The direct lookup of the other clients websocket is overly simplified.
            // In the real world you might be running in a cluster and would need to send
            // messages between different servers in the cluster to reach the other side.
            if (!handler) {
                console.log('peer not found', data.id);
                // TODO: the protocol needs some error handling here. This can be as
                // simple as sending a 'bye' with an extra error element saying 'not-found'.
                return;
            }

            if (data.type === 'candidate') {
                handler.emit('candidate',data.candidate || {completed: true});
            } else if (data.type === 'offer') {
                console.log((new Date()).toISOString(), "publishing ", data.id);

                publisher.once('publish', answer=> ws.send(JSON.stringify({id: data.id, type: 'answer', sdp: answer})));
                await publisher.publish(data.sdp);

                clearTimeout(publishThrottleTimer);

                publishThrottleTimer = setTimeout( async ()=> {
                    const {resolve, reject} = await room.Lock();
                    try {
                        const publisherIds = getPublishers();

                        // loop through publishers and update feeds for its subsciber
                        await Promise.allSettled(publisherIds.map(async (id) => {

                            const subscriber = connections.get(`${id}-sub`);

                            console.log((new Date()).toISOString(), subscriber.id, " is subscribing to ", publisherIds);

                            // BL stuff should be done here (e.g. sending different pubs to different subs)

                            const feeds = await subscriber.beginSubscribe(publisherIds);

                            console.log((new Date()).toISOString(), "sending offer to ", subscriber.id);

                            subscriber.connection.send(JSON.stringify({
                                id: subscriber.id,
                                type: 'offer',
                                sdp: feeds.jsep.sdp
                            }));
                        }));
                        resolve();
                    } catch(e) {
                        reject(e);
                    }
                },200);
            }
            if (data.type === 'answer') {

                console.log((new Date()).toISOString(), "received answer from ", data.id);

                await handler.finalizeSubscribe(data.sdp);
            }
        });
    });

});