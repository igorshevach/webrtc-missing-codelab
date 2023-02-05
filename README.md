## WebRTC - the missing codelab
 Sample based simple http/signalling server using Janus sfu as backend

### Prerequisites:
 janus server is built.

### Limitations:
 - tested locally (so far).
 - no stun/turn servers are provided
 - tested on chrome only

### - run Janus:
  docker run --rm -it -p 20000:80  -p 8088:8088 -p 7088:7088 -p 8188:8188  -p 10000-10050:10000-10050/udp kaltura/kme-janus   /opt/janus/bin/janus  --rtp-port-range=10000-10050 --nat-1-1=127.0.0
### - start server: from the root folder run:
  npm start
### - open clients in the browser: 
  http://localhost:8081/ 
  - up to 3 - as it defaults to max 3 publishers (can be easily extended).

## - enjoy 
    (??)
