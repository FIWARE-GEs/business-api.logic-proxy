/*global expect, it, jasmine, describe */

/* Copyright (c) 2015 - 2017 CoNWeT Lab., Universidad Politécnica de Madrid
 *
 * This file belongs to the business-ecosystem-logic-proxy of the
 * Business API Ecosystem
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var proxyrequire = require("proxyquire"),
    md5 = require("blueimp-md5"),
    config = require("../../config"),
    utils = require("../../lib/utils"),
    testUtils = require("../utils.js"),
    Readable = require('stream').Readable,
    Transform = require('stream').Transform,
    requestLib = require('request'),
    nock = require('nock');

describe("Test index helper library", function () {

    var createSearchMock = function createSearchMock(extra, indexStore) {
        var si = {
            add: function () {

                class AddWrite extends Transform {
                    constructor(opt) {
                        super(opt);
                    }

                    _transform(data, encoding, callback) {
                        extra.readStream.push(data);
                        callback(extra.adderr);
                    }
                }

                return new AddWrite({
                    writableObjectMode: true,
                    readableObjectMode: true
                })
            },
            defaultPipeline(opt) {
                class DefaultPipe extends Transform {
                    constructor(opt) {
                        super(opt);
                    }

                    _transform(data, encoding, callback) {
                        this.push(data);
                        callback();
                    }
                }
                return new DefaultPipe({
                    writableObjectMode: true,
                    readableObjectMode: true
                });
            },
            close: function (cb) {
                cb(extra.closeerr);
            },
            del: function (key, cb) {
                if (extra.checkdel) {
                    extra.checkdel(key);
                }

                cb(extra.delerr);
            },
            search: function (query) {
                if (extra.checksearch) {
                    extra.checksearch(query);
                }

                if (extra.dataArray) {
                    extra.searchdata = extra.dataArray.shift();
                }

                // Create a mock read stream to map the results
                class SearchRead extends Readable {
                    constructor(opt) {
                        super(opt);
                        this._data = Array.isArray(extra.searchdata) ? extra.searchdata.slice() : [];
                    }

                    _read() {
                        if (extra.searcherr) {
                            process.nextTick(() => this.emit('error', extra.searcherr));
                            return;
                        }

                        if (this._data.length > 0) {
                            var elem = this._data.shift();
                            this.push(elem);
                        } else {
                            this.push(null);
                        }
                    }
                }

                return new SearchRead({
                    objectMode: true
                });
            }
        };

        spyOn(si, "add").and.callThrough();
        spyOn(si, "defaultPipeline").and.callThrough();
        spyOn(si, "close").and.callThrough();
        spyOn(si, "del").and.callThrough();
        spyOn(si, "search").and.callThrough();

        ['offerings', 'products', 'catalogs', 'inventory', 'orders'].forEach((index) => {
            indexStore[index] = si;
        });

        return si;
    };

    var getIndexLib = function getIndexLib(method, request, level) {
        if (!method) {
            method = function () {};
        }

        if (!request) {
            request = function () {};
        }

        if (!level) {
            level = function(tab, opt, cb) {
                cb(null, null);
            }
        }

        var mockUtils = proxyrequire('../../lib/utils.js', {
            './../config.js': testUtils.getDefaultConfig()
        });
        
        return proxyrequire("../../lib/indexes.js", {
            "search-index": method,
            "request": request,
            "./utils": mockUtils,
            "levelup": level,
            '../config': testUtils.getDefaultConfig()
        });
    };

    it("should have correct tables", function () {
        var indexes = getIndexLib();
        expect(indexes.siTables.offerings).toEqual("indexes/offerings");
        expect(indexes.siTables.products).toEqual("indexes/products");
        expect(indexes.siTables.catalogs).toEqual("indexes/catalogs");
    });

    var testIndexInit = function (
        levelErr, levelResp, searchErr, searchResp, levCalls, searchCalls, store, callValidator, errValidator, done) {

        var levelMock = jasmine.createSpy().and.callFake((val, opt, cb) => {
            cb(levelErr, levelResp);
        });
        var searchIndex = jasmine.createSpy().and.callFake((opt, cb) => {
            cb(searchErr, searchResp);
        });

        var indexes = getIndexLib(searchIndex, null, levelMock);

        var validator = function (handler) {
            expect(levelMock.calls.count()).toBe(levCalls);
            expect(searchIndex.calls.count()).toBe(searchCalls);

            handler(levelMock, searchIndex);

            expect(indexes.getDataStores()).toEqual(store);
            done();
        };

        indexes.init()
            .then(validator.bind(this, callValidator))
            .catch(validator.bind(this, errValidator));
    };

    it('should initialize the search index when calling init', function(done) {
        var db = {};
        var si = {};
        var down = require('leveldown');

        testIndexInit(null, db, null, si, 5, 5, {
            offerings: si,
            products: si,
            catalogs: si,
            inventory: si,
            orders: si
        }, (levelMock, searchIndex) => {
            var expInd = ['indexes/offerings', 'indexes/products', 'indexes/catalogs', 'indexes/inventory', 'indexes/orders'];

            expInd.forEach(indexPath => {
                // Validate levelup creation
                expect(levelMock).toHaveBeenCalledWith(indexPath, {
                    valueEncoding: 'json',
                    db: down
                }, jasmine.any(Function));

                // Validate search indexes creation
                expect(searchIndex).toHaveBeenCalledWith({
                    indexes: db
                }, jasmine.any(Function));
            });
        }, null, done);
    });

    it('should fail to initialize the search index when leveldb fails', function (done) {
        var down = require('leveldown');

        testIndexInit('Level error', {}, null, {}, 1, 0, {}, null, (levelMock) => {
            expect(levelMock).toHaveBeenCalledWith('indexes/offerings', {
                valueEncoding: 'json',
                db: down
            }, jasmine.any(Function));
        }, done);
    });

    it('should fail to initialize the search index when si fails', function (done) {
        var down = require('leveldown');
        var db = {};

        testIndexInit(null, db, 'Search error', {}, 1, 1, {}, null, (levelMock, searchIndex) => {
            expect(levelMock).toHaveBeenCalledWith('indexes/offerings', {
                valueEncoding: 'json',
                db: down
            }, jasmine.any(Function));

            expect(searchIndex).toHaveBeenCalledWith({
                indexes: db
            }, jasmine.any(Function));

        }, done);
    });

    var mockCloseIndexes = function (err) {
        var searchIndex = jasmine.createSpyObj('searchIndex', ['close']);
        searchIndex.close.and.callFake((cb) => {
            cb(err);
        });

        var indexes = getIndexLib();
        var dataStores = indexes.getDataStores();

        dataStores.offerings = searchIndex;
        dataStores.products = searchIndex;
        dataStores.catalogs = searchIndex;
        dataStores.inventory = searchIndex;
        dataStores.orders = searchIndex;

        return {
            searchIndex: searchIndex,
            indexes: indexes
        };
    };

    it('should close the indexes when calling close', function(done) {
        var closeMock = mockCloseIndexes(null);

        closeMock.indexes.close().then(function() {
            expect(closeMock.searchIndex.close.calls.count()).toBe(5);
            done();
        });
    });

    it('should fail closing the indexes when close gives an error', function (done) {
        var errMsg = 'Closing error';
        var closeMock = mockCloseIndexes(errMsg);

        closeMock.indexes.close().catch(function(err) {
            expect(closeMock.searchIndex.close.calls.count()).toBe(1);
            expect(err).toBe(errMsg);
            done();
        });
    });

    var helper = function helper(extra, f1, success, error) {
        var indexes = getIndexLib(null, extra.request);
        var si = createSearchMock(extra, indexes.getDataStores());

        indexes[f1].apply(this, Array.prototype.slice.call(arguments, 4))
            .then(extra => success(si, extra))
            .catch(err => error(si, err));
    };

    it("should reject promise when an invalid path has been provided when removing an index", function (done) {
        var path = 'testp';

        helper({}, "removeIndex", (si, data) => {
            expect("Error, promise resolved instead of rejected!: " + data).toBe(true);
            done();
        }, (si, err) => {
            expect(err).toBe('There is not a search index for the given path');
            expect(si.del).not.toHaveBeenCalled();
            done();
        }, path, "key");
    });

    it("should reject promise when index del method gives an error", function(done) {
        var path = 'inventory';
        var extra = {
            delerr: 'ERROR'
        };

        helper(extra, "removeIndex", (si, data) => {
            expect("Error, promise resolved instead of rejected!: " + data).toBe(true);
            done();
        }, (si, err) => {
            expect(err).toBe('ERROR');
            expect(si.del).toHaveBeenCalledWith(['key'], jasmine.any(Function));
            done();
        }, path, "key");
    });

    it("should resolve the promise when index del method works", function (done) {
        var testkey = "KEY";
        var path = 'inventory';

        var extra = {
            checkdel: key => {
                expect(key).toEqual([testkey]);
            }
        };

        helper(extra, "removeIndex", (si, data) => {
            expect(data).toBeUndefined();
            expect(si.del).toHaveBeenCalledWith([testkey], jasmine.any(Function));
            done();
        }, (si, err) => {
            expect("Error, promise rejected instead of resolved: " + err).toBe(true);
            done();
        }, path, testkey);
    });

    var searchHelper = function searchHelper(done, q, d, method) {
        var newq = q;
        if (!q.query) {
            newq = {query: q};
        }

        var extra = {
            checksearch: query => {
                expect(query).toEqual(newq);
            },
            searchdata: d
        };

        helper(extra, method, (si, data) => {
            expect(data).toEqual(d);
            expect(si.search).toHaveBeenCalledWith(newq);
            done();
        }, (si, err) => {
            expect("Error, promise rejected instead of resolved: " + err).toBe(true);
            done();
        }, q);
    };

    it("should use offering index and search correctly", function (done) {
        searchHelper(done, {}, [1], "searchOfferings");
    });

    it("should use products index and search correctly", function (done) {
        searchHelper(done, {}, [1], "searchProducts");
    });

    it("should use catalogs index and search correctly", function (done) {
        searchHelper(done, {}, [1], "searchCatalogs");
    });

    it("should use inventory index and search correctly", function (done) {
        searchHelper(done, {}, [1], "searchInventory");
    });

    it("should use order index and search correctly", function (done) {
        searchHelper(done, {}, [1, 2, 3], "searchOrders");
    });

    it("should reject search promise when search method fails", function (done) {
        var extra = {
            searcherr: 'ERROR stream',
            searchdata: [1]
        };

        var q = {
            query: {}
        };

        helper(extra, 'searchInventory', () => {
            expect("Error, promise resolved instead of rejected: ").toBe(true);
            done();
        }, (si, err) => {
            expect(si.search).toHaveBeenCalledWith(q);
            expect(err).toBe(extra.searcherr);
            done()
        }, q);
    });

    it("should fix the user id doing an MD5 hash", function () {
        var indexes = getIndexLib();
        expect(indexes.fixUserId("some-id_")).toEqual(md5("some-id_"));
    });

    it("should search the ID fixing it before", function () {
        var indexes = getIndexLib();
        var f = {
            f: () => {}
        };

        spyOn(f, "f");
        indexes.searchUserId(f.f, "id");

        expect(f.f).toHaveBeenCalledWith({query: {AND: {userId: [md5("id")]}}});
    });

    // CATALOGS

    var catalogData = {
        id: 3,
        href: "http://3",
        description: "Description",
        lifecycleStatus: "Obsolete",
        name: "Name",
        relatedParty: [{id: "rock"}]
    };

    var catalogExpected = {
        id: "catalog:3",
        originalId: 3,
        body: ["name", "description"],
        sortedId: "000000000003",
        relatedPartyHash: [md5("rock")],
        relatedParty: ["rock"],
        href: "http://3",
        lifecycleStatus: "Obsolete",
        name: "Name"
    };

    var catOpt = {
        lifecycleStatus: {
            fieldOptions: {
                preserveCase: false
            }
        },
        body: {
            fieldOptions: {
                preserveCase: false
            }
        }
    };

    var testSaveIndexes = function testSaveIndexes(method, data, expected, done, user, ext, opts) {
        if(!ext) {
            ext = {};
        }

        if(!opts) {
            opts = catOpt;
        }

        var extra = Object.assign({
            readStream : []
        }, ext);

        helper(extra, method, (si, val) => {
            expect(val).toBeUndefined();
            expect(si.add).toHaveBeenCalled();
            expect(si.defaultPipeline).toHaveBeenCalledWith(opts);
            expect(si.close).not.toHaveBeenCalled();

            // Loaded by the writable stream
            expect(extra.readStream).toEqual([expected]);
            done(si);
        }, (si, err) => {
            expect("Error, promise rejected instead of resolved: " + err).toBe(true);
            done();
        }, [data], user);
    };

    var testSaveIndexesErr = function testSaveIndexesErr(method, data, done) {
        var extra = {
            adderr: 'Error adding',
            readStream : []
        };

        helper(extra, method, () => {
            expect("Error, promise resolved instead of rejected: " + err).toBe(true);
            done();
        }, (si, err) => {
            expect(si.add).toHaveBeenCalled();
            expect(si.defaultPipeline).toHaveBeenCalledWith(catOpt);
            expect(err).toBe(extra.adderr);
            done();
        }, [data]);
    };

    it("should save converted catalog data correctly", function (done) {
        testSaveIndexes('saveIndexCatalog', catalogData, catalogExpected, done);
    });

    it("should reject the promise when the catalog data cannot be saved", function (done) {
        testSaveIndexesErr('saveIndexCatalog', catalogData, done);
    });

    // PRODUCTS

    var productData = {
        id: 1,
        href: "http://1",
        name: "name",
        brand: "brand",
        description: "Product Description",
        lifecycleStatus: "Active",
        isBundle: false,
        productNumber: 12,
        relatedParty: [{id: "rock-8"}, {id: "rock-9"}]
    };

    var productExpected = {
        id: "product:1",
        href: "http://1",
        lifecycleStatus: "Active",
        isBundle: false,
        productNumber: 12,
        originalId: 1,
        sortedId: "000000000001",
        body: ["name", "brand", "product description"],
        relatedPartyHash: [md5("rock-8"),  md5("rock-9")],
        relatedParty: ["rock-8", "rock-9"]
    };


    it("should save converted product data correctly", function (done) {
        testSaveIndexes('saveIndexProduct', productData, productExpected, done);
    });

    it("should reject the promise when the product data cannot be saved", function (done) {
        testSaveIndexesErr('saveIndexProduct', productData, done);
    });

    // OFFERINGS

    var notBundleOffer = {
        id: 2,
        productSpecification: productData,
        name: "name",
        description: "description",
        href: "http://2",
        lifecycleStatus: "Active",
        isBundle: false,
        catalog: "2"
    };

    var notBundleCategoriesOffer = Object.assign({}, notBundleOffer, {
        id: 12,
        lifecycleStatus: "Disabled",
        category: [{ id: 13, href: "http://cat/13" }]
    });

    var notBundleMultipleCategoriesOffer = Object.assign({}, notBundleCategoriesOffer, {
        category: [{ id: 13, href: "http:13" }, { id: 14, href: "http:14" }]
    });

    var bundleOffer = Object.assign({}, notBundleOffer, {
        id: 3,
        bundledProductOffering: [{ id: 2 }],
        href: "http://3",
        productSpecification: null,
        isBundle: true,
        catalog: "2"
    });

    var bundleExpected = {
        id: "offering:3",
        originalId: 3,
        name: "name",
        sortedId: "000000000003",
        body: ["name", "description"],
        userId: md5("rock-8"),
        productSpecification: undefined,
        href: "http://3",
        lifecycleStatus: "Active",
        isBundle: true,
        catalog: "000000000002"
    };

    var notBundleExpected = Object.assign({}, bundleExpected, {
        id: "offering:2",
        originalId: 2,
        name: "name",
        sortedId: "000000000002",
        productSpecification: "000000000001",
        href: "http://2",
        isBundle: false,
        catalog: "000000000002"
    });

    var notBundleCategoriesOfferExpect = Object.assign({}, notBundleExpected, {
        id: "offering:12",
        originalId: 12,
        name: "name",
        sortedId: "000000000012",
        lifecycleStatus: "Disabled",
        categoriesId: ['000000000013'],
        categoriesName: [md5("testcat13")],
        catalog: "000000000002"
    });

    var notBundleMultipleCategoriesOfferExpected = Object.assign({}, notBundleCategoriesOfferExpect, {
        categoriesId: ['000000000013', '000000000014'],
        categoriesName: [md5("testcat13"), md5("testcat14")]
    });

    it('should save converted offering data with a explicit user', function (done) {
        testSaveIndexes('saveIndexOffering', notBundleOffer, notBundleExpected, done, {id: "rock-8"});
    });

    it('should save converted offering data searching owner in products index', function (done) {
        var extra = {
            searchdata: [{
                document: {
                    relatedParty: ["rock-8"]
                }
            }]
        };

        testSaveIndexes('saveIndexOffering', notBundleOffer, notBundleExpected, (si) => {
            expect(si.search).toHaveBeenCalledWith({query: {AND: {sortedId: ['000000000001']}}});
            done();
        }, undefined, extra);
    });

    var testSaveCategoryOffering = function testSaveCategoryOffering (ids, offer, convOffer, done) {
        var auxIds = Object.assign([], ids);

        var request = jasmine.createSpy().and.callFake((url, f) => {
            var id = ids.shift();
            f(null, {}, JSON.stringify({
                id: id,
                name: "TestCat" + id
            }));
        });

        var extra = {
            request: request
        };

        testSaveIndexes('saveIndexOffering', offer, convOffer, () => {

            var catInfo = testUtils.getDefaultConfig().endpoints.catalog;
            var protocol = catInfo.appSsl ? 'https': 'http';

            auxIds.forEach((id) => {
                var curl = protocol +'://' + catInfo.host + ':' + catInfo.port +'/' +
                    catInfo.path + "/api/catalogManagement/v2/category/" + id;

                expect(request).toHaveBeenCalledWith(curl, jasmine.any(Function));
            });

            done()

            }, {id: "rock-8"}, extra);
    };

    it('should save converted offering with categories', function (done) {
        testSaveCategoryOffering([13], notBundleCategoriesOffer, notBundleCategoriesOfferExpect, done);
    });

    it('should save converted offering with multiple categories', function (done) {
        testSaveCategoryOffering([13, 14], notBundleMultipleCategoriesOffer, notBundleMultipleCategoriesOfferExpected, done);
    });

    it('should save converted bundle with an explicit user', function (done) {
        testSaveIndexes('saveIndexOffering', bundleOffer, bundleExpected, done, {id: "rock-8"});
    });

    it('should convert offer with bundle searching user in products and offerings index', function(done) {
        var offer = [{
            document: {
                productSpecification: "00000000001"
            }
        }];

        var product = [{
            document: {
                relatedParty: ["rock-8"]
            }
        }];

        var extra = {
            dataArray: [offer, product]
        };

        testSaveIndexes('saveIndexOffering', bundleOffer, bundleExpected, (si) => {

            [{query: {AND: {sortedId: ["000000000001"]}}}, {query: {AND: {sortedId: ["000000000002"]}}}].forEach((q) => {
                expect(si.search).toHaveBeenCalledWith(q);
            });

            done()
        }, undefined, extra);
    });

    // Inventory && Orders

    var inventoryData = {
        id: 12,
        productOffering: {
            id: 5,
            href: "http://myserver.com/catalog/offering/5"
        },
        relatedParty: [{id: "rock", role: "customer"}],
        href: "http://12",
        name: "inventoryName",
        status: "status",
        startDate: 232323232,
        orderDate: 232323231,
        terminationDate: 232323233
    };
    
    var inventoryExpected = {
        id: "inventory:12",
        originalId: 12,
        body: ["offername2", "description2"],
        sortedId: "000000000012",
        productOffering: 5,
        relatedPartyHash: [md5("rock")],
        relatedParty: ["rock"],
        href: "http://12",
        name: "inventoryName",
        status: "status",
        startDate: 232323232,
        orderDate: 232323231,
        terminationDate: 232323233
    };

    var invOpt = {
        status: {
            fieldOptions: {
                preserveCase: false
            }
        },
        body: {
            fieldOptions: {
                preserveCase: false
            }
        }
    };

    it('should save converted inventory data correctly', function (done) {
        var extra = {
            request: requestLib
        };

        var catHost = "http://" + testUtils.getDefaultConfig().endpoints.catalog.host + ":" + testUtils.getDefaultConfig().endpoints.catalog.port;
        var catPath = "/catalog/offering/5";

        nock(catHost)
            .get(catPath)
            .reply(200, {name: "OfferName2", description: "Description2"});

        testSaveIndexes('saveIndexInventory', inventoryData, inventoryExpected, done, undefined, extra, invOpt);
    });

    var orderData = {
        id: 23,
        relatedParty: [{id: "rock", role: "customer"}, {id: "user", role: "seller"}],
        href: "http://23",
        priority: "prior",
        category: "endofunctor",
        state: "active",
        notificationContact: "m@c.es",
        note: ""
    };

    var orderExpected = {
        id: "order:23",
        originalId: 23,
        sortedId: "000000000023",
        relatedPartyHash: [md5("rock")],
        sellerHash: [md5("user")],
        relatedParty: ["rock", "user"],
        href: "http://23",
        priority: "prior",
        category: "endofunctor",
        state: "active",
        notificationContact: "m@c.es",
        note: ""
    };

    var orderOpt = {
        status: {
            fieldOptions: {
                preserveCase: false
            }
        }
    };

    it("should save converted order data correctly", function (done) {
        testSaveIndexes('saveIndexOrder', orderData, orderExpected, done, undefined, {}, orderOpt);
    });

    describe("Request helpers", function () {
        it('should add or condition correctly', function() {
            var indexes = getIndexLib();
            var q = { OR: []};
            indexes.addOrCondition(q, "name", ["test", "test2"]);

            expect(q).toEqual({ OR: [[{name: ["test"]}, {name: ["test2"]}]]});
        });

        it("should add or when query don't have or", function() {
            var indexes = getIndexLib();
            var q = {};

            indexes.addOrCondition(q, "name", ["test"]);
            expect(q).toEqual({ OR: [[{name: ["test"]}]]});
        });

        it('should add and condition correctly', function() {
            var indexes = getIndexLib();
            var q = { AND: []};
            indexes.addAndCondition(q, {id: ["rock"]});

            expect(q).toEqual({ AND: [{id: ["rock"]}]});
        });

        it("should add or when query don't have or", function() {
            var indexes = getIndexLib();
            var q = {};

            indexes.addAndCondition(q, "COND");
            expect(q).toEqual({ AND: ["COND"]});
        });

        it('should create query correctly', function() {
            var indexes = getIndexLib();

            var fs = {f: () => {}};
            spyOn(fs, "f");
            var req = {query: {}};

            var query = indexes.genericCreateQuery([], "", fs.f, req);

            expect(fs.f).toHaveBeenCalledWith(req, { AND: [], OR: [] });

            expect(query).toEqual({
                sort: {
                    field: "sortedId",
                    direction: "asc"
                },
                query: [{
                    AND: {}
                }]
            });
        });


        it('should create query correctly with offset and size', function() {
            var indexes = getIndexLib();

            var fs = {f: () => {}};
            spyOn(fs, "f");
            var req = {query: {
                offset: 2,
                size: 23
            }};

            var query = indexes.genericCreateQuery([], "", fs.f, req);

            expect(fs.f).toHaveBeenCalledWith(req, { AND: [], OR: [] });

            expect(query).toEqual({
                offset: 2,
                pageSize: 23,
                sort: {
                    field: "sortedId",
                    direction: "asc"
                },
                query: [{
                    AND: {}
                }]
            });
        });

        it('should create query with extra parameters', function() {
            var indexes = getIndexLib();

            var req = {query: {
                key1: "VALUE1",
                key2: 23,
                notadded: "not"
            }};

            var query = indexes.genericCreateQuery(["key1", "key2", "notextra"], "", null, req);

            expect(query).toEqual({
                sort: {
                    field: "sortedId",
                    direction: "asc"
                },
                query: [{
                    AND: {
                        key1: ["value1"],
                        key2: [23]
                    }
                }]
            });
        });

        it('should not execute if GET request', function () {
            var indexes = getIndexLib();

            var req = {
                method: "POST"
            };

            var fs = {
                reg: {test: () => {}},
                createOffer: () => {},
                search: () => {}
            };

            spyOn(fs.reg, "test");
            spyOn(fs, "createOffer");
            spyOn(fs, "search");

            indexes.getMiddleware(fs.reg, fs.createOffer, fs.search, req);
            expect(fs.reg.test).not.toHaveBeenCalled();
            expect(fs.createOffer).not.toHaveBeenCalled();
            expect(fs.search).not.toHaveBeenCalled();
        });

        it("should not execute if regex don't test", function() {
            var indexes = getIndexLib();

            var req = {
                method: "GET",
                apiUrl: "url"
            };

            var fs = {
                reg: {test: () => {}},
                createOffer: () => {},
                search: () => {}
            };

            spyOn(fs.reg, "test").and.callFake(s => new RegExp('noturl').test(s));
            spyOn(fs, "createOffer");
            spyOn(fs, "search");

            indexes.getMiddleware(fs.reg, fs.createOffer, fs.search, req);
            expect(fs.reg.test).toHaveBeenCalledWith("url");
            expect(fs.createOffer).not.toHaveBeenCalled();
            expect(fs.search).not.toHaveBeenCalled();
        });

        it('should not execute if query have explicit id', function() {
            var indexes = getIndexLib();

            var req = {
                method: "GET",
                apiUrl: "url",
                query: {
                    id: "1,2,3"
                }
            };

            var fs = {
                reg: {test: () => {}},
                createOffer: () => {},
                search: () => {}
            };

            spyOn(fs.reg, "test").and.returnValue(true);
            spyOn(fs, "createOffer");
            spyOn(fs, "search");

            indexes.getMiddleware(fs.reg, fs.createOffer, fs.search, req);
            expect(fs.reg.test).toHaveBeenCalledWith("url");
            expect(fs.createOffer).not.toHaveBeenCalled();
            expect(fs.search).not.toHaveBeenCalled();
        });

        it('should execute middleware with default search correctly', function(done) {
            var indexes = getIndexLib();

            var req = {
                method: "GET",
                apiUrl: "url",
                query: {
                    depth: "2",
                    notadd: "not"
                },
                _parsedUrl: {
                    pathname: "path"
                }
            };

            var fs = {
                reg: {test: () => {}},
                createOffer: () => {},
                search: () => {}
            };

            var results =[{document: {originalId: 1}}, {document: {originalId: 2}}];

            var search = {
                sort: {
                    field: "sortedId",
                    direction: "asc"
                },
                query: {
                    AND: { "*": ["*"]}
                }
            };

            spyOn(fs.reg, "test").and.returnValue(true);
            spyOn(fs, "createOffer").and.callFake(indexes.genericCreateQuery.bind(this, [], "", null));
            spyOn(fs, "search").and.returnValue(Promise.resolve(results));

            indexes.getMiddleware(fs.reg, fs.createOffer, fs.search, req)
                .then(() => {
                    expect(fs.reg.test).toHaveBeenCalledWith("url");
                    expect(fs.createOffer).toHaveBeenCalled();
                    expect(fs.search).toHaveBeenCalledWith(search);

                    expect(req.apiUrl).toEqual("path?id=1,2&depth=2");
                    done();
                });
        });

        it('should execute middleware search correctly without results', function(done) {
            var indexes = getIndexLib();

            var req = {
                method: "GET",
                apiUrl: "url",
                query: {
                    fields: "value",
                    notadd: "not"
                },
                _parsedUrl: {
                    pathname: "path"
                }
            };

            var results = [];
            var search = {
                query: [{
                    AND: {'search': ['value']}
                }]
            };

            var fs = {
                reg: {test: () => {}},
                createOffer: () => search,
                search: () => {}
            };

            spyOn(fs.reg, "test").and.returnValue(true);
            spyOn(fs, "createOffer").and.callThrough();
            spyOn(fs, "search").and.returnValue(Promise.resolve(results));

            indexes.getMiddleware(fs.reg, fs.createOffer, fs.search, req)
                .then(() => {
                    expect(fs.reg.test).toHaveBeenCalledWith("url");
                    expect(fs.createOffer).toHaveBeenCalled();
                    expect(fs.search).toHaveBeenCalledWith(search);

                    expect(req.apiUrl).toEqual("path?id=&fields=value");
                    done();
                });
        });
    });
});
