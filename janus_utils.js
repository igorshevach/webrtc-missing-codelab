const WebSocket = require("ws");
const uuid = require("uuid");
const EventEmitter = require('events');


function asleep(ms){
    return new Promise(resolve=> {
        setTimeout(()=>{
            resolve();
        },ms);
    });
}

let TID = 0;
function getTransactionId(sessionId) {
    const tid = TID;
    TID += 1;
    return `${sessionId}-${tid}`;
}

const janVideoRoomPluginName = "JANUS.plugin.VideoRoom".toLowerCase();

class Janus {
    constructor(url){
        this.wsJanus = new WebSocket(url,['janus-protocol']);
        this.id = url;
        this.sessionId = uuid.v4();
        this.janSessionId = null;
        this.janusCalls = new Map();
        this.handleLookup = new Map();
        this.inited = new Promise( (resolve,reject) => {
            this.wsJanus.onopen = () => {
                this.create().then(resolve).catch(reject);
            };
        });
        this.wsJanus.onerror = (e) => console.error(e);
        this.wsJanus.onmessage = async (message) => {
            console.log(this.janSessionId, (new Date()).toISOString(), '<- ', message.data);
            try  {
                const janMsg = JSON.parse(message.data);
                await this.processJanusMessage(janMsg);
            } catch (err) {
                console.log(this.janSessionId, 'invalid json', err, message);
            }
        };
    }

    async create() {
      const reply = await this.invoke({
            janus: "create"
        });

        this.janSessionId = reply.data.id;
    }

    async invoke(message, fil = null) {
        const transId = getTransactionId(this.sessionId);
        message = { transaction: transId, ... message };
        if(this.janSessionId)
            message.session_id = this.janSessionId;
        message = JSON.stringify(message);
        console.log(`${(new Date()).toISOString()} -> ${message}`);
        await this.wsJanus.send(message);
        return new Promise( (resolve,reject) => {
            fil = !!fil ? fil : data=>data.janus !== 'ack';
            this.janusCalls.set( transId, (data, err) => {
                if(err)
                    reject(err);
                else if(fil(data))
                    resolve(data);
            });
        });
    }
    async createPluginHandle(){
        const reply = await this.invoke({
            janus: "attach",
            plugin: janVideoRoomPluginName
        });
        return reply.data.id;
    }

    async destroyPluginHandle(handle_id){
        try {
            await this.invoke({
                janus: "detach",
                handle_id
            });
        } catch(e){

        }
    }

    // janus 'message' reply:
    //{
    //   "janus": "success",
    //   "session_id": 8751238408634731,
    //   "transaction": "de7c1160-7322-43fa-9906-655affc4c162-1",
    //   "sender": 3746921539295228,
    //   "plugindata": {
    //     "plugin": "janus.plugin.videoroom",
    //     "data": {
    //       "videoroom": "event",
    //       "error_code": 430,
    //       "error": "Invalid element type (room should be a positive integer)"
    //     }
    //   }
    // }
    async createRoom(roomId) {
        const handleId = await this.createPluginHandle();
        try {
            const plugin = await this.invoke({
                janus: "message",
                session_id: this.janSessionId,
                handle_id: handleId,
                body: {
                    request: 'create',
                    room: roomId
                }
            });

            const msg = plugin.plugindata.data;
            if (msg.error) {
                switch (msg.error_code) {
                    // already exists
                    case 427:
                        break;
                    default:
                        throw new Error(`${msg.error_code} ${msg.error}`);
                }
            } else {
                if (!msg.videoroom)
                    throw new Error('no videoroom');
                if (msg.room !== roomId)
                    throw new Error(`unexpected room id ${msg.room}`);
                if (msg.videoroom !== 'created')
                    throw new Error('videoroom !== created');
            }
            console.log("connected to video room ", roomId);
            return new VideoRoom(this, handleId, roomId);
        } catch(e){
            this.destroyPluginHandle(handleId);
            throw e;
        }
    }

    fromHandle(hid){
        return this.handleLookup.get(hid);
    }

    async createSfuClient(room, externalId) {
        const [handleId, handleId2]  = await Promise.all([this.createPluginHandle(), this.createPluginHandle()]);
        try {
            const id = externalId || handleId;
            const pub = new Sublisher(room, handleId,  id);
            const sub = new Sublisher(room,handleId2,`${id}-sub`);
            this.handleLookup.set(pub.handleId, pub);
            this.handleLookup.set(sub.handleId, sub);
            return [pub, sub];
        } catch(e){
            await this.destroyPluginHandle(handleId);
        }
    }

    async processJanusMessage(janMsg) {
        if(!janMsg.janus)
            throw new Error(`no janus`);

        //server side event
        if(!janMsg.transaction){
            const subpub = this.fromHandle(janMsg.sender);
            if(!subpub)
                return;
            if(janMsg.janus === 'hangup') {
                subpub.destroy(janMsg.janus);
            } else {
                subpub.onMessage(janMsg);
            }
            return;
        }

        const ev = this.janusCalls.get(janMsg.transaction);

        //TODO!!!
        //this.janusCalls.delete(janMsg.transaction);

        const err = janMsg.janus === 'error' ?
            new Error(`${this.sessionId} janus error code ${janMsg.error.code} reason: ${janMsg.error.reason}`) : null;

        ev(janMsg, err);
    }

    async deleteHandle(obj) {
        this.handleLookup.delete(obj.handleId);
        await this.destroyPluginHandle(obj.handleId);
    }
}

class VideoRoom {
    constructor(server, handleId, roomId){
        this.server = server;
        this.id = roomId;
        this.handleId = handleId;
        this.lockPromise = Promise.resolve();
    }

    createClient(id){
        return this.server.createSfuClient(this, id);
    }
    async Lock() {
        await this.lockPromise;
        let resolve;
        let reject;
        this.lockPromise = new Promise((_resolve,_reject)=>{
            resolve = _resolve;
            reject = _reject;
        });
        return {resolve,reject};
    }
}

class VideoRoomHandle extends EventEmitter {

    constructor(room,handleId){
        super();
        this.handleId = handleId;
        this.room = room;
    }

    get sessionId() {
        return this.room.sessionId;
    }

    async requestVideoRoom(verb, message = null, extra = null) {
        message = message || {};
        extra = extra || {};
        const reply = await this.room.server.invoke({
            janus: "message",
            handle_id: this.handleId,
            ... extra,
            body: {
                request: verb,
                room: this.room.id,
                ...message
            }
        });
        const plugindata = reply.plugindata ? reply.plugindata.data : {error: 'badly formed event'};
        if (plugindata.error)
            throw new Error(`${plugindata.error_code} ${plugindata.error}`);
        return { data: reply.plugindata.data, jsep: reply.jsep};
    }

    async destroy(reason){
        console.log(`destroying ${this.handleId} due to: ${reason}`);
        if(this.handleId) {
            await this.room.deleteHandle(this);
            super.emit('close', reason);
        }
    }
    set onclose(cb) {
        super.on('close', cb);
    }
}

class Sublisher extends VideoRoomHandle {

    constructor(room,handle,id){
        super(room,handle);
        this.id = id;
        this.joined = false;
    }

    prepareTrickle(sdp) {
        if (sdp.indexOf('a=end-of-candidates') < 0) {
            const candidates = [];
            return new Promise(resolve=>{
                this.on('candidate', candidate=>{
                    candidates.push(candidate);
                    if(candidate.completed)
                        resolve(candidates);
                });
            });
        }
        return Promise.resolve([]);
    }

    async publish(sdp) {

        const candidatesPromise = this.prepareTrickle(sdp);

        const publishedPromise = new Promise( resolve=>this.once('media', resolve));

        const {data,jsep} = await this.requestVideoRoom('joinandconfigure',
            { ptype: 'publisher',id: this.id,},
            { jsep: {type : "offer",sdp} }
        );
        if(data.videoroom !== 'joined')
            throw new Error("received badly formed answer from server");
        if(!jsep.sdp || jsep.type != "answer")
            throw new Error("received badly formed answer from server");

        // notify answer is ready
        this.emit('publish',jsep.sdp);

        await Promise.all([
            publishedPromise,
            candidatesPromise
                .then(candidates=>{
                    if (candidates.length > 0)
                        return this.trickle(candidates);
                })
        ]);

        return {streams:data.streams, answer:jsep.sdp};
    }
    async unpublish(){
        await this.requestVideoRoom('unpublish',
            {
                ptype: 'publisher',
                id: this.id
            });
        return super.destroy('unpublish');
    }


    async beginSubscribe(publisherIds) {

        const verb = this.joined  ? 'subscribe' : 'join';

        const streams = publisherIds.map(feed=>{return {feed};});

        if(streams.length > 0) {
            const ret = await this.requestVideoRoom(verb,
                {
                    ptype: 'subscriber',
                    id: this.id,
                    streams
                });
            this.joined = verb === 'join';
            return ret;
        } else {
            throw new Error('no participant added');
        }
    }

    async finalizeSubscribe(sdp) {
        await this.requestVideoRoom('start',
            { ptype: 'subscriber',id: this.id},
            { jsep: {type : "answer",sdp } });
    }

    async unsubscribe(){
        await this.requestVideoRoom('leave',
            {
                id: this.id
            });
        return super.destroy('unsubscribe');
    }

    async trickle(candidates){

        return await this.room.server.invoke({janus: "trickle",
                handle_id: this.handleId,
                candidates},
            // janus trickle does not return event with completion status :(
            ()=>true);
    }

    onMessage(msg) {
        switch(msg.janus){
            case "slowlink":
            case 'media':
                this.emit(msg.janus,msg);
                break;
        }
    }

    get stats() { return {id: this.id, handle_id: this.handleId};}
}


module.exports = {
    Janus
}
