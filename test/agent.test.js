'use strict';

var path                = require('path')
  , sinon               = require('sinon')
  , chai                = require('chai')
  , should              = chai.should()
  , expect              = chai.expect
  , helper              = require(path.join(__dirname, 'lib', 'agent_helper'))
  , configurator        = require(path.join(__dirname, '..', 'lib', 'config'))
  , logger              = require(path.join(__dirname, '..', 'lib', 'logger'))
                            .child({component : 'TEST'})
  , Agent               = require(path.join(__dirname, '..', 'lib', 'agent'))
  , Transaction         = require(path.join(__dirname, '..', 'lib', 'transaction'))
  , Metrics             = require(path.join(__dirname, '..', 'lib', 'metrics'))
  , CollectorConnection = require(path.join(__dirname, '..', 'lib',
                                            'collector', 'connection'))
  ;

describe("the New Relic agent", function () {
  it("accepts a custom configuration as an option passed to the constructor",
     function () {
    var config = configurator.initialize(logger, {config : {sample : true}});
    var agent = new Agent({config : config});

    expect(agent.config.sample).equal(true);
  });

  describe("when connecting to the collector", function () {
    var agent;

    beforeEach(function () {
      agent = new Agent();
    });

    it("retries on failure", function (done) {
      // _nextConnectAttempt requires that agent.connection exist
      agent.setupConnection();

      agent._failAndRetry = function () { return done(); };

      var backoff = agent.nextBackoff();
      expect(backoff).eql({interval : 15, warn : false, error : false});

      agent._nextConnectAttempt(backoff);

      agent.connection.emit('connectError', 'testConnect', new Error('agent test'));
    });

    it("gives up after retrying 6 times", function (done) {
      // _nextConnectAttempt requires agent.connection exist
      agent.setupConnection();

      agent._failAndShutdown = function () { return done(); };
      agent.connectionFailures = 6;

      var backoff = agent.nextBackoff();
      expect(backoff).eql({interval : 300, warn : false, error : true});

      agent._nextConnectAttempt(backoff);

      agent.connection.emit('connectError', 'testConnect', new Error('agent test'));
    });
  });

  describe("with a stubbed collector connection", function () {
    var agent
      , connection
      ;

    beforeEach(function (done) {
      agent = helper.loadMockedAgent();

      agent.on('connect', function () {
        connection = agent.connection;

        return done();
      });

      agent.start();
    });

    afterEach(function () {
      helper.unloadAgent(agent);
    });

    it("bootstraps its configuration", function () {
      should.exist(agent.config);
    });

    it("still has a connection, which is stubbed", function () {
      should.exist(connection);
    });

    it("has an error tracer", function () {
      should.exist(agent.errors);
    });

    it("uses an aggregator to apply top N slow trace logic", function () {
      should.exist(agent.traces);
    });

    it("has a metric normalizer", function () {
      should.exist(agent.normalizer);
    });

    it("has a consolidated metrics collection that transactions feed into", function () {
      should.exist(agent.metrics);
    });

    it("has a function to look up the active transaction", function () {
      expect(function () { agent.getTransaction(); }).not.throws();
    });

    it("has some debugging configuration by default", function () {
      should.exist(agent.config.debug);
    });

    describe("with debugging configured", function () {
      it("internal instrumentation is disabled by default", function () {
        var debug = agent.config.debug;
        expect(debug.internal_metrics).equal(false);
      });

      it("internal instrumentation can be configured",
         function () {
        var config = configurator.initialize(logger, {
          config : {debug : {internal_metrics : true}}
        });
        var debugged = new Agent({config : config});

        var debug = debugged.config.debug;
        expect(debug.internal_metrics).equal(true);
      });

      describe("with internal instrumentation enabled", function () {
        var debugged;

        beforeEach(function () {
          var config = configurator.initialize(logger, {
            config : {debug : {internal_metrics : true}}
          });
          debugged = new Agent({config : config});
        });

        it("should have an object for tracking internal metrics", function () {
          expect(debugged.config.debug.supportability).not.equal(undefined);
        });

        it("should find an internal metric for transaction processed", function (done) {
          debugged.once('transactionFinished', function () {
            var supportability = debugged.config.debug.supportability
              , metric = supportability.getMetric('Supportability/Transaction/Count')
              ;

            expect(metric, 'is defined').not.equal(undefined);
            expect(metric.callCount, 'has been incremented').equal(1);

            return done();
          });

          var transaction = new Transaction(debugged);
          transaction.end();
        });
      });
    });

    describe("when handling events", function () {
      it("should update the metrics' apdex tolerating value when configuration changes",
         function (done) {
        expect(agent.metrics.apdexT).equal(0.5);
        process.nextTick(function () {
          should.exist(agent.metrics.apdexT);
          expect(agent.metrics.apdexT).equal(0.666);

          return done();
        });

        agent.config.emit('change', {'apdex_t' : 0.666});
      });

      it("should reset the configuration and metrics normalizer on connection",
         function (done) {
        expect(agent.config.apdex_t).equal(0.5);
        process.nextTick(function () {
          expect(agent.config.apdex_t).equal(0.742);
          expect(agent.metrics.apdexT).equal(0.742);
          expect(agent.normalizer.rules).deep.equal([]);

          return done();
        });

        connection.emit('connect', {apdex_t : 0.742, url_rules : []});
      });

      it("should parse metrics responses when metric data is received",
         function (done) {
        var NAME     = 'Custom/Test/events';
        var SCOPE    = 'TEST';
        var METRICID = 17;

        var testIDs = {};
        testIDs[NAME + ',' + SCOPE] = METRICID;

        expect(agent.mapper.length).equal(0);
        process.nextTick(function () {
          expect(agent.mapper.map(NAME, SCOPE)).equal(17);

          return done();
        });

        connection.emit('metricDataResponse',
                        [[{name : NAME, scope : SCOPE}, METRICID]]);
      });

      it("should capture the trace off a finished transaction", function (done) {
        var trans = new Transaction(agent);
        // need to initialize the trace
        trans.getTrace().setDurationInMillis(2100);

        agent.once('transactionFinished', function () {
          var trace = agent.traces.trace;
          should.exist(trace);
          expect(trace.getDurationInMillis(), "same trace just passed in").equal(2100);

          return done();
        });

        trans.end();
      });
    });

    describe("when apdex_t changes", function () {
      var APDEX_T = 0.9876;

      it("should update its own apdexT", function () {
        expect(agent.apdexT).not.equal(APDEX_T);

        agent.onApdexTChange({apdex_t : APDEX_T});

        expect(agent.apdexT).equal(APDEX_T);
      });

      it("should update the current metrics collection's apdexT", function () {
        expect(agent.metrics.apdexT).not.equal(APDEX_T);

        agent.onApdexTChange({apdex_t : APDEX_T});

        expect(agent.metrics.apdexT).equal(APDEX_T);
      });
    });

    describe("when new metric name -> ID mappings may or may not have come in",
             function () {
      it("shouldn't throw if no new rules are received", function () {
        expect(function () { agent.onNewMappings(null); }).not.throws();
      });

      it("shouldn't throw if new rules are received", function () {
        var rules = [[{name : 'Test/RenameMe1'}, 1001],
                     [{name : 'Test/RenameMe2', scope : 'TEST'}, 1002]];

        expect(function () { agent.onNewMappings(rules); }).not.throws();
      });
    });

    describe("when new metric normalization rules may or may not have come in",
             function () {
      it("shouldn't throw if no new rules are received", function () {
        expect(function () { agent.onNewNormalizationRules(null); }).not.throws();
      });

      it("shouldn't throw if new rules are received", function () {
        var rules = {
          url_rules : [
            {each_segment : false, eval_order : 0, terminate_chain : true,
             match_expression : '^(test_match_nothing)$',
             replace_all : false, ignore : false, replacement : '\\1'},
            {each_segment : false, eval_order : 0, terminate_chain : true,
             match_expression : '.*\\.(css|gif|ico|jpe?g|js|png|swf)$',
             replace_all : false, ignore : false, replacement : '/*.\\1'},
            {each_segment : false, eval_order : 0, terminate_chain : true,
             match_expression : '^(test_match_nothing)$',
             replace_all : false, ignore : false, replacement : '\\1'}
          ]
        };

        expect(function () { agent.onNewNormalizationRules(rules); }).not.throws();
      });
    });
  });

  describe("with a mocked connection", function () {
    var agent
      , mock
      ;

    beforeEach(function () {
      var connection = new CollectorConnection({
        config : {applications : function () { return 'none'; }}
      });

      mock = sinon.mock(connection);

      agent = new Agent({connection : connection});
      agent.setupConnection();
      connection.agentRunId = '1337';
    });

    afterEach(function () {
      mock.expects('send').once().withArgs('shutdown');

      agent.stop();
      mock.verify();
    });

    describe("when sending data to the collector", function () {
      it("the last reported time is congruent with reality", function () {
        mock.expects('sendMetricData').once().withExactArgs(agent.metrics);

        agent.submitMetricData();
      });
    });

    describe("when harvesting", function () {
      it("reports the error count", function () {
        agent.metrics.started = 1337;

        var transaction = new Transaction(agent);
        transaction.setWeb('/test', 'WebTransaction/Uri/test', 501);
        agent.errors.add(transaction, new TypeError('no method last on undefined'));
        agent.errors.add(transaction, new Error('application code error'));
        agent.errors.add(transaction, new RangeError('stack depth exceeded'));
        transaction.end();

        var metrics = new Metrics(0.5);
        metrics.started = 1337;
        metrics.getOrCreateMetric('Errors/all').incrementCallCount(4);

        mock.expects('sendMetricData').once().withArgs(metrics);
        mock.expects('sendTracedErrors').once();
        mock.expects('sendTransactionTraces').once();

        agent.harvest();
      });
    });
  });
});
