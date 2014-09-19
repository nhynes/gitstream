var util = require('util'),
    utils = require('./utils'),
    exerciseUtils = require('./exerciseUtils'),
    _ = require('lodash'),
    uuid = require('node-uuid'),
    EventEmitter = require('events').EventEmitter,
    GIT_EVENTS = utils.events2Props( [ 'on', 'handle' ],
        [ 'pre-pull', 'pull', 'pre-clone', 'clone', 'pre-push', 'push', 'pre-info', 'info',
        'merge', 'pre-rebase', 'pre-commit', 'commit', 'checkout', 'pre-receive', 'receive' ] );


/**
 * A state machine that represents multi-step exercises as states.
 *
 * This class is an EventEmitter:
 *  Event `step`: (newState, oldState, data)
 *  Event `halt`: (haltState)`
 *  If a time limit is specified, a `ding` event will be emitted when the timer runs out
 *
 * @param {Object} config @see ExerciseMachineConfigExample.js for configuration parameters
 * @param {String} repoPaths { String path: the repo short path, String fsPath: the fs path }
 * @param {String} exercisePath the path to the exercise directory
 * @param {EventBus} eventBus the EventBus on which to listen for repo events
 * Once initialized, if a time limit is set, the end timestamp will be available as .endTimestamp
 */
function ExerciseMachine( config, repoPaths, exerciseDir, eventBus ) {
    if ( !config || !repoPaths || !exerciseDir || !eventBus ) {
        throw Error('Missing required param(s)');
    }
    if ( !(this instanceof ExerciseMachine) ) {
        return new ExerciseMachine( config, repoPaths, exerciseDir, eventBus );
    }

    this._configStartState = config.startState;
    delete config.startState;
    this._timeLimit = config.timeLimit; // in seconds
    delete config.timeLimit;

    this._repo = repoPaths.path;
    this._eventBus = eventBus;

    this._exerciseUtils = exerciseUtils({ repoDir: repoPaths.fsPath, exerciseDir: exerciseDir });

    this._states = config;
    this._currentListeners = [];
    this._currentHandlers = [];
    this.halted = true;
}

util.inherits( ExerciseMachine, EventEmitter );

_.extend( ExerciseMachine.prototype, {
    /**
     * Initializes this ExerciseMachine with the provided start state and starts the clock
     * This method is idempotent once the machine has been started
     * @param {String} startState the start state. Default: startState specified by config
     * @param {Number} timeLimit the exercise time limit in seconds.
     *  Default: timeLimit specified by config
     * @return {ExerciseMachine} the current ExerciseMachine
     */
    init: function( startState, timeLimit ) {
        if ( this._state !== undefined ) { return; }

        this._timeLimit = timeLimit || this._timeLimit;
        this.halted = false;
        if ( this._timeLimit ) {
            Object.defineProperty( this, 'endTimestamp', {
                value: Date.now() + this._timeLimit * 1000,
                writable: false
            });
            setTimeout( function() {
                if ( !this.halted ) {
                    this.emit('ding');
                    this.halt();
                }
            }.bind( this ), this._timeLimit * 1000 );
        }
        this._step( startState || this._configStartState );
        return this;
    },

    /**
     * Steps the ExerciseMachine into the given state and fires a corresponding event
     *  Event `step`: (newState, oldState, data)
     *  Event `halt`: (haltState)
     *
     * The `null` state is defined as the halt state. States returning `null` are also halt states
     * Further steps when halted do nothing.
     *
     * @param {String} state the state into which to step
     */
    _step: function( newState, incomingData ) {
        var oldState = this._state,
            newStateConf = this._states[ newState ],
            entryPoint,
            doneFn = function( stepTo, stepData ) {
                var emitData = { prev: incomingData, new: stepData };
                this.emit( 'step', newState, oldState, emitData );
                if ( stepTo !== undefined ) { this._step( stepTo ); }
                this._setUp();
            }.bind( this );

        if ( this.halted ) { return; }

        this._tearDown();
        this._state = newState;

        if ( newState === null || newStateConf === null ) {
            this.halted = true;
            if ( newState !== null ) { this.emit( 'step', newState, oldState ); }
            this.emit( 'halt', newState !== null ? newState : oldState );
            return;
        }

        if ( this.state !== undefined && newStateConf === undefined ) {
            throw Error('No definition for state: ' + newState + '. Prev state: ' + oldState );
        }

        entryPoint = typeof newStateConf !== 'object' ? newStateConf :
            ( newStateConf.onEnter ? newStateConf.onEnter : function( done ) { done(); } );

        if ( typeof entryPoint === 'function' ) {
            entryPoint.call( this._exerciseUtils, doneFn );
        } else {
            doneFn( entryPoint );
        }
    },

    /**
     * Sets up the current state
     */
    _setUp: function() {
        var stateConfig = this._states[ this._state ],
            doneFn = function( stepTo, data ) {
                this._step( stepTo, data );
            }.bind( this );

        _.map( stateConfig, function( stateValue, stateProp) {
            var repoAction = GIT_EVENTS[ stateProp ],
                uniqName,
                registerFn;
            if ( !repoAction ) { return; }

            if ( stateProp.indexOf('handle') === 0 ) {
                registerFn = this._eventBus.setHandler.bind( this._eventBus );
                this._currentHandlers.push({ action: repoAction });
            } else {
                uniqName = uuid.v1();
                registerFn = this._eventBus.addListener.bind( this._eventBus, uniqName );
                this._currentListeners.push({ name: uniqName, action: repoAction });
            }

            registerFn( this._repo, repoAction, function() {
                var listenerArgs = Array.prototype.slice.call( arguments );
                // stateValue is the transition function
                if ( typeof stateValue === 'function' ) {
                    stateValue.apply( this._exerciseUtils, listenerArgs.concat( doneFn ) );
                } else {
                    doneFn( stateValue );
                }
            }.bind( this ) );
        }.bind( this ) );
    },

    /**
     * Tears down the current state
     */
    _tearDown: function() {
        this._currentListeners.map( function( listener ) {
            this._eventBus.removeListener( listener.name, this._repo, listener.action );
        }.bind( this ) );
        this._currentHandlers.map( function( handler  ) {
            this._eventBus.setHandler( this._repo, handler.action, undefined );
        }.bind( this ) );
        this._currentListeners = [];
        this._currentHandlers = [];
    },

    /**
     * Forcibly halts this ExerciseMachine
     */
    halt: function() {
        this._step( null );
    }
});

module.exports = ExerciseMachine;
