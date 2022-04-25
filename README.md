# Multi-source downloader

### Usage
Step 1: [Get Node.js](https://nodejs.org/en/download/package-manager/) (I tested on v16.14.2)

Step 2: Clone the repo: `git clone https://github.com/itsnotnoah/downloader`

Step 3: Navigate to the downloader: `cd downloader`

Step 4: Run the downloader:  `node dl.js`

### Assumptions (aka: How to Break It)
The downloader supports downloads from multiple sources, and it's configured to download a > 100 MB video file which I've mirrored across two of my personal web servers. It assigns chunks to sources using a naive round robin strategy.

The downloader is designed to work with HTTP 1.1 servers which support byte range requests and return a Content-Length header. There is no sanity checking of configuration parameters, and it's possible to create unreasonable combinations of sources and max simultaneous TCP connections. 

We keep the entire download in RAM until it's complete, so the downloader is only guaranteed up to files of a certain size. I tested some random ~400 MB files I found on the internet, and worked for me.

We only verify the download against nginx entity tags. 