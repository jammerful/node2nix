var url = require('url');
var path = require('path');
var crypto = require('crypto');
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var tar = require('tar');
var nijs = require('nijs');
var Source = require('./Source.js').Source;
var inherit = require('nijs/lib/ast/util/inherit.js').inherit;

/**
 * Constructs a new HTTPSource instance.
 *
 * @class HTTPSource
 * @extends Source
 * @classdesc Represents a dependency source that is obtained by fetching a file from an external HTTP site
 *
 * @constructor
 * @param {String} baseDir Directory in which the referrer's package.json configuration resides
 * @param {String} dependencyName Name of the dependency
 * @param {String} versionSpec Version specifier of the Node.js package to fetch
 */
function HTTPSource(baseDir, dependencyName, versionSpec) {
    Source.call(this, baseDir, versionSpec);
    this.dependencyName = dependencyName;
    this.identifier = dependencyName + "-" + versionSpec;
    this.baseDir = path.join(baseDir, dependencyName);
}

/* HTTPSource inherits from Source */
inherit(Source, HTTPSource);

/**
 * @see Source#fetch
 */
HTTPSource.prototype.fetch = function(callback) {
    var self = this;

    /* Determine which client to use depending on the parsed protocol */
    var parsedUrl = url.parse(self.versionSpec);
    var client;

    switch(parsedUrl.protocol) {
        case "http:":
            client = http;
            break;
        case "https:":
            client = https;
            break;
        default:
            return callback("Unsupported protocol: "+parsedUrl.protocol);
    }

    /* Request the package from the given URL */

    var request = client.get(parsedUrl.href, function(res) {
        if(res.statusCode >= 300 && res.statusCode <= 308) { // If a redirect has been encountered => do the same operation with the target URL
            if(!res.headers.location) {
                callback("Bad HTTP response while GETting "+parsedUrl.href+" Redirect with no Location header");
            } else {
                self.versionSpec = res.headers.location;
                self.fetch(callback);
            }
        } else { // Otherwise extract the package.json and compute the corresponding hash
            self.url = parsedUrl.href;
            process.stderr.write("fetching: "+self.url+"\n");

            /* Callback that gets invoked when the tar parser finished or the response has been received */
            function finish() {
                callback();
            }

            var gunzip = zlib.createGunzip();
            gunzip.on("error", function(err) {
                callback("Error while gunzipping: "+err);
            });

            var tarParser = new tar.Parse();
            tarParser.on("error", function(err) {
                callback("Error while untarring: "+err);
            });
            tarParser.on("entry", function(entry) {
                if(entry.path.match(/^[^/]*\/package\.json$/)) { // Search for a file named package.json in the tar file
                    var packageJSON = "";

                    entry.on("data", function(chunk) {
                        packageJSON += chunk;
                    });

                    entry.on("end", function() {
                        self.config = JSON.parse(packageJSON);

                        if(self.hash !== undefined) { // Only consider the work done if the hash has been computed as well
                            finish();
                        }
                    });
                } else {
                    // For other files, simply skip them. We need these dummy callbacks because there is some kind of quirk in the API that terminates the program.
                    entry.on("data", function() {});
                    entry.on("end", function() {});
                }
            });

            var computeHash = crypto.createHash('sha256');

            /* Pipe gunzipped data to the tar parser */
            gunzip.pipe(tarParser);

            res.on("data", function(chunk) {
                /* Retrieve data from the HTTP connection and feed it to the gunzip and hash streams */
                gunzip.write(chunk);
                computeHash.update(chunk);
            });
            res.on("end", function() {
                self.hash = computeHash.digest('hex');

                if(self.config !== undefined) { // Only consider the work done if the package configuration has been extracted as well
                    finish();
                }
            });
            res.on("error", function(err) {
                callback("Error with retrieving file from HTTP connection: "+err);
            });
        }
    });
    request.on("error", function(err) {
        callback("Error while GETting "+self.url+": "+err);
    });
};

/**
 * @see NixASTNode#toNixAST
 */
HTTPSource.prototype.toNixAST = function() {
    var ast = Source.prototype.toNixAST.call(this);

    ast["src"] = new nijs.NixFunInvocation({
        funExpr: new nijs.NixExpression("fetchurl"),
        paramExpr: {
            name: this.config.name + "-" + this.config.version + ".tar.gz",
            url: new nijs.NixURL(this.url),
            sha256: this.hash
        }
    });

    return ast;
};

exports.HTTPSource = HTTPSource;
