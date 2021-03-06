'use strict';

/**
 * An imposter represents a protocol listening on a socket.  Most imposter
 * functionality is in each particular protocol implementation.  This module
 * exists as a bridge between the API and the protocol, mapping back to pretty
 * JSON for the end user.
 * @module
 */

function createErrorHandler (deferred, port) {
    return error => {
        const errors = require('../util/errors');

        if (error.errno === 'EADDRINUSE') {
            deferred.reject(errors.ResourceConflictError(`Port ${port} is already in use`));
        }
        else if (error.errno === 'EACCES') {
            deferred.reject(errors.InsufficientAccessError());
        }
        else {
            deferred.reject(error);
        }
    };
}

/**
 * Create the imposter
 * @param {Object} Protocol - The protocol factory for creating servers of that protocol
 * @param {Object} creationRequest - the parsed imposter JSON
 * @param {Object} baseLogger - the logger
 * @param {Object} config - command line options
 * @returns {Object}
 */
function create (Protocol, creationRequest, baseLogger, config) {
    function scopeFor (port) {
        let scope = `${creationRequest.protocol}:${port}`;

        if (creationRequest.name) {
            scope += ' ' + creationRequest.name;
        }
        return scope;
    }

    const Q = require('q'),
        deferred = Q.defer(),
        domain = require('domain').create(),
        errorHandler = createErrorHandler(deferred, creationRequest.port),
        compatibility = require('./compatibility'),
        requests = [],
        logger = require('../util/scopedLogger').create(baseLogger, scopeFor(creationRequest.port)),
        helpers = require('../util/helpers'),
        imposterState = {};

    let stubs;
    let resolver;
    let numberOfRequests = 0;
    let metadata = {};

    compatibility.upcast(creationRequest);

    // If the CLI --mock flag is passed, we record even if the imposter level recordRequests = false
    const recordRequests = config.recordRequests || creationRequest.recordRequests;

    function getResponseFor (request) {
        numberOfRequests += 1;
        if (recordRequests) {
            const recordedRequest = helpers.clone(request);
            recordedRequest.timestamp = new Date().toJSON();
            requests.push(recordedRequest);
        }

        const responseConfig = stubs.getResponseFor(request, logger, imposterState);
        return resolver.resolve(responseConfig, request, logger, imposterState).then(response => {
            if (config.recordMatches && !response.proxy) {
                if (response.response) {
                    // Out of process responses wrap the result in an outer response object
                    responseConfig.recordMatch(response.response);
                }
                else {
                    // In process resolution
                    responseConfig.recordMatch(response);
                }
            }
            return Q(response);
        });
    }

    function getProxyResponseFor (proxyResponse, proxyResolutionKey) {
        return resolver.resolveProxy(proxyResponse, proxyResolutionKey, logger).then(response => {
            if (config.recordMatches) {
                response.recordMatch();
            }
            return Q(response);
        });
    }

    domain.on('error', errorHandler);
    domain.run(() => {
        Protocol.createServer(creationRequest, logger, getResponseFor).done(server => {
            if (creationRequest.port !== server.port) {
                logger.changeScope(scopeFor(server.port));
            }
            logger.info('Open for business...');

            metadata = server.metadata;
            stubs = server.stubs;
            resolver = server.resolver;

            if (creationRequest.stubs) {
                creationRequest.stubs.forEach(stubs.addStub);
            }

            function addDetailsTo (result) {
                if (creationRequest.name) {
                    result.name = creationRequest.name;
                }
                result.recordRequests = Boolean(creationRequest.recordRequests);

                Object.keys(metadata).forEach(key => {
                    result[key] = metadata[key];
                });

                result.requests = requests;
                result.stubs = stubs.stubs();
            }

            function removeNonEssentialInformationFrom (result) {
                result.stubs.forEach(stub => {
                    /* eslint-disable no-underscore-dangle */
                    if (stub.matches) {
                        delete stub.matches;
                    }
                    stub.responses.forEach(response => {
                        if (helpers.defined(response.is) && helpers.defined(response.is._proxyResponseTime)) {
                            delete response.is._proxyResponseTime;
                        }
                    });
                });
                delete result.numberOfRequests;
                delete result.requests;
                delete result._links;
            }

            function removeProxiesFrom (result) {
                result.stubs.forEach(stub => {
                    stub.responses = stub.responses.filter(response => !response.hasOwnProperty('proxy'));
                });
                result.stubs = result.stubs.filter(stub => stub.responses.length > 0);
            }

            function toJSON (options) {
                // I consider the order of fields represented important.  They won't matter for parsing,
                // but it makes a nicer user experience for developers viewing the JSON to keep the most
                // relevant information at the top
                const result = {
                    protocol: creationRequest.protocol,
                    port: server.port,
                    numberOfRequests: numberOfRequests
                };

                options = options || {};

                if (!options.list) {
                    addDetailsTo(result);
                }

                result._links = { self: { href: '/imposters/' + server.port } };

                if (options.replayable) {
                    removeNonEssentialInformationFrom(result);
                }
                if (options.removeProxies) {
                    removeProxiesFrom(result);
                }

                return result;
            }

            function stop () {
                const stopDeferred = Q.defer();
                server.close(() => {
                    logger.info('Ciao for now');
                    return stopDeferred.resolve({});
                });
                return stopDeferred.promise;
            }

            return deferred.resolve({
                port: server.port,
                url: '/imposters/' + server.port,
                toJSON,
                addStub: server.stubs.addStub,
                stop,
                resetProxies: stubs.resetProxies,
                getResponseFor,
                getProxyResponseFor
            });
        });
    });

    return deferred.promise;
}

module.exports = { create };
