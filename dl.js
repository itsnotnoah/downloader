"use strict";

const https = require("https");
const fs = require("fs");

/**
 * Global configuration
 */ 
const MAX_PARALLEL_DOWNLOADS = 64;
const DEFAULT_CHUNK_SZ = 1024 * 1024 * 8;
const FILENAME = "revision_4_720p_4mbps_08202019.mp4";
const SOURCES = [
  {
    hostname: "www.stealingurfeelin.gs",
    path: "/vid/"
  },
  {
    hostname: "www.freefood.is",
    path: "/tmp/"
  }
];

/**
 * Our customized user agent. Unlike Node's default globalAgent, our agent is configured to 
 * implement socket pooling and reuse, capping the number of simultaneous TCP connections.
 */
const AGENT = new https.Agent({
  keepAlive: true,
  maxTotalSockets: MAX_PARALLEL_DOWNLOADS,
  maxFreeSockets: Number.Infinity
});

/**
 * A Chunk represents the state of a download of some byte range of some file from some source.
 */ 
function Chunk({idx, hostname, path, filename, start, end} = {}) {
  this.idx = idx;
  this.hostname = hostname;
  this.path = path;
  this.filename = filename;
  this.start = start;
  this.end = end;
  this.downloaded = 0;
}

/**
 * Fetch the http headers for our desired resource from each of the specified sources. 'sources' 
 * must be formatted like the global SOURCES array. Returns a parallel array of response headers.
 */ 
async function get_source_headers(agent, sources, filename) {
  const reqs = [];

  sources.forEach((source) => {
    const options = {
      agent: agent,
      hostname: source.hostname,
      path: `${source.path}${filename}`,
      method: "HEAD"
    };

    reqs.push(new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.on("data", (chunk) => {
          /**
           * Do nothing. Even though the response body should be empty, we must implement this 
           * empty handler because the clientRequest won't fire the "end" event and return the 
           * socket to the pool unless we consume the data from the Stream.Readable.
           */
        });

        resolve(res.headers);
      });

      req.on("error", (err) => reject(err));
      req.end();
    }));
  });

  return await Promise.all(reqs);
}

/**
 * Perform very basic source validation. 'source_hdrs' must be an array of http headers produced by
 * 'get_source_headers'. We confirm that a content-length header is present, that the file size 
 * matches across responses, and that each source supports byte range requests. Returns a bool.
 */ 
function is_valid_sources(source_hdrs) {
  if (source_hdrs.length < 1) {
    return false;
  }

  return source_hdrs.every((hdr) => {
    return hdr["accept-ranges"] === "bytes" && hdr["content-length"] && 
      hdr["content-length"] === source_hdrs[0]["content-length"];
  });
}

/**
 * Download performance depends on the number of chunks, the size of each chunk, the network 
 * throughput between us and each source, the max parallel TCP connections, and the size of the 
 * file. We don't have an amazing chunking heuristic (yet), but we abstract the chunking logic in 
 * this function to make room for future improvement. Currently, we just create chunks of 'chunk_sz' 
 * bytes and assign them to sources using a round robin strategy.
 */ 
function make_chunks(filename, file_sz, chunk_sz, sources) {
  if (chunk_sz > file_sz) {
    throw new Error("chunk_sz cannot be larger than file_sz");
  }

  const n_chunks = Math.ceil(file_sz / chunk_sz);
  return Array.from(new Array(n_chunks).keys()).map((chunk_i) => {
    const source = sources[chunk_i % sources.length];

    /**
     * Per RFC 7233, we actually don't need to know the exact size of the last chunk. We compute it
     * just so we can print a percentage-based download status message to the screen.
     */  
    const start = chunk_i * chunk_sz;
    const size = chunk_i < n_chunks - 1 ? chunk_sz : file_sz - chunk_i * chunk_sz;

    return new Chunk({
      idx: chunk_i,
      hostname: source.hostname,
      path: source.path,
      filename: filename,
      start: start,
      end: start + size - 1
    });
  });
}

/**
 * Perform a parallel download for an array of chunks produced by 'make_chunks'. Callback function
 * 'status_cb' is executed on every 'data' event fired by each IncomingMessage's Stream.Readable.
 */ 
async function download(agent, chunks, file_sz, status_cb = () => {}) {
  const reqs = [];
  const buf = Buffer.alloc(file_sz);

  chunks.forEach((chunk) => {
    const options = {
      agent: agent,
      hostname: chunk.hostname,
      path: `${chunk.path}${chunk.filename}`,
      method: "GET",
      headers: {
        "Range": `bytes=${chunk.start}-${chunk.end}`
      }
    }

    reqs.push(new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {      
        res.on("data", (data) => {
          data.copy(buf, chunk.start + chunk.downloaded);
          chunk.downloaded += data.length;
          status_cb(chunks);
        });

        res.on("end", () => resolve());      
      });

      req.on("error", (err) => reject(err));
      req.end();
    }));
  });

  await Promise.all(reqs);
  return buf;
}

/**
 * Status callback
 */ 
function log_status(chunks) {
  console.clear();
  console.log(chunks.map((chunk) => {
    const sz = chunk.end - chunk.start + 1;
    return `${(chunk.downloaded * 100 / sz).toFixed(2)}%\t${chunk.idx + 1}/${chunks.length}\t` + 
      `(${sz} bytes)\t${chunk.hostname}`;
  }).join("\n"));
}

/**
 * Verify a local file against an entity tag generated by nginx. Our assumptions about nginx's etag 
 * conventions are based on an interpretation of the nginx source code:
 * 
 * http://lxr.nginx.org/source/xref/nginx/src/http/ngx_http_core_module.c?r=7984%3Aae992b5a27b2
 * 
 * At line 1698, we see that the etag is constructed from the hexadecimal representation of the last 
 * modified time and the content length, separated by a dash, and wrapped in quotes. We consider 
 * only the content length portion of the etag. It's admittedly a bit pointless, as the content 
 * length doesn't tell us much about the validity of the file.
 */ 
function verify_etag_nginx(path, etag_val) {
  const stats = fs.statSync(path);
  return etag_val.replaceAll("\"", "").split("-")[1] === stats.size.toString(16);
}

/**
 * Do the parallel download, write the file, verify the result!
 */ 
(async () => {
  const t1 = Date.now();
  const source_hdrs = await get_source_headers(AGENT, SOURCES, FILENAME);

  if (!is_valid_sources(source_hdrs)) {
    console.log("Error: invalid sources!");
    return;
  }

  const file_sz = parseInt(source_hdrs[0]["content-length"]);
  const chunks = make_chunks(FILENAME, file_sz, DEFAULT_CHUNK_SZ, SOURCES);
  const buf = await download(AGENT, chunks, file_sz, log_status);
  const t2 = Date.now();

  fs.writeFile(FILENAME, buf, (err) => {
    if (err) {
      throw err;
    }

    console.log(`\nDone! Downloaded ${FILENAME} (${buf.length} bytes) ` + 
      `from ${SOURCES.length} source${SOURCES.length > 1 ? "s" : ""} in ` + 
        `${((t2 - t1) / 1000).toFixed(2)}s.\n`);

    /**
     * Brittle method to verify ONLY nginx etags: For each source that returned a "server" header, 
     * we look for substring "nginx"...
     */ 
    source_hdrs.forEach((hdr, i) => {
      if (hdr.etag && hdr.server && hdr.server.includes("nginx")) {
        const is_valid = verify_etag_nginx(FILENAME, hdr.etag);
        console.log(`${SOURCES[i].hostname} runs ${hdr.server}, etag ${hdr.etag} looks ` + 
          `${is_valid ? "good" : "bad"}.`);
      } else {
        console.log(`${SOURCES[i].hostname} sent no etag or an unknown etag type.`);
      }
    });

    console.log("\nHave a nice day.\n");
  });
})();