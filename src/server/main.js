var angler = require('git-angler'),
    compression = require('compression'),
    connect = require('connect'),
    duplexEmitter = require('duplex-emitter'),
    path = require('path'),
    redis = require('redis'),
    shoe = require('shoe'),
    spawn = require('child_process').spawn,
    q = require('q'),
    user = require('./user')({
        sqlHost: 'localhost', sqlUser: 'nhynes', sqlPass: 'localdev', sqlDb: 'gitstream'
    }),
    ExerciseMachine = require('./ExerciseMachine'),
    app = connect(),
    server,
    eventBus = new angler.EventBus(),
    PATH_TO_REPOS = '/srv/repos',
    PATH_TO_EXERCISES = '/srv/exercises',
    repoNameRe = /exercise[1-9][0-9]*\.git$/,
    backend,
    rcon = redis.createClient(),
    githookEndpoint = angler.githookEndpoint({
        pathToRepos: PATH_TO_REPOS,
        eventBus: eventBus,
        gitHTTPMount: '/repos/'
    }),
    CLIENT_IDLE_TIMEOUT = 60 * 60 * 1000, // 1 hr before resting client state expires
    PORT = 4242,
    logErr = function( err ) { if ( err ) { console.error( 'Error: ' + err ); } };

/**
 * Extracts data from the components of a repo's path
 * @param {String|Array} repoPath a path string or an array of path components
 * @return {Object|Boolean} data - if repo path is invalid, returns null
 *  { userId: String, exerciseName: String, mac: String, macMsg: String }
 */
function extractRepoInfoFromPath( repoPath ) {
    var splitRepoPath = repoPath instanceof Array ? repoPath : repoPath.split('/').slice(1),
        repoNameInfo,
        userId,
        repoMac,
        exerciseName,
        macMsg;

    if ( splitRepoPath.length < 2) {
        return null;
    }

    repoNameInfo = splitRepoPath[ splitRepoPath.length - 1 ].split('-');
    exerciseName = repoNameInfo.slice( 1 ).join('').replace( /\.git$/, '' );
    userId = splitRepoPath[ splitRepoPath.length - 2 ]; // e.g. /nhynes/repo.git - gets nhynes
    repoMac = repoNameInfo[0]; // e.g. /nhynes/12345-repo.git - gets 12345
    macMsg = userId + exerciseName; // e.g. nhynesexercise2

    return {
        userId: userId,
        exerciseName: exerciseName,
        mac: repoMac,
        macMsg: macMsg
    };
}

/** Does the inverse of @see extractRepoInfoFromPath. macMsg is not required */
function createRepoShortPath( info ) {
    return path.join( '/', info.userId, info.mac + '-' + info.exerciseName + '.git' );
}

/**
 * Verifies the MAC provided in a repo's path (ex. /username/beef42-exercise2.git)
 * @param {String|Array} repoPath a path string or an array of path components
 * @param {Function} cb errback of the form function( err, repoInfo ).
 *  If err is truthy, verification has failed.
 *  Otherwise, repoInfo will contain:
 *      { userId: String, exerciseName: String, mac: String, macMsg: string }
 *    or null if the repo path is invalid
 */
function verifyAndGetRepoInfo( repoPath, cb ) {
    var repoInfo = extractRepoInfoFromPath( repoPath ),
        verifyCb = function( err, verificationSuccess ) {
            cb( err, verificationSuccess ? repoInfo : null );
        };

    if ( !repoInfo ) { cb( null, null ); }

    user.verifyMac( repoInfo.userId, repoInfo.mac, repoInfo.macMsg, verifyCb );
}

// transparently initialize exercise repos right before user clones it
eventBus.setHandler( '*', '404', function( repoName, _, data, clonable ) {
    if ( !repoNameRe.test( repoName ) ) { return clonable( false ); }

    verifyAndGetRepoInfo( repoName, function( err, repoInfo ) {
        var pathToRepo,
            exerciseRepo,
            pathToStarterRepo,
            mkdir,
            cp;

        if ( err || !repoInfo ) { return clonable( false ); }

        exerciseRepo = repoInfo.exerciseName + '.git'; // exerciseX.git
        pathToRepo = path.join( PATH_TO_REPOS, repoName );
        pathToStarterRepo = path.join( PATH_TO_EXERCISES, '/starting', exerciseRepo );

        mkdir = spawn( 'mkdir', [ '-p', path.dirname( pathToRepo ) ] );
        mkdir.on( 'close', function( mkdirRet ) {
            if ( mkdirRet !== 0 ) { clonable( false ); }

            cp = spawn( 'cp', [ '-r', pathToStarterRepo, pathToRepo ] );
            cp.on( 'close', function( cpRet ) {
                clonable( cpRet === 0 );
            });
        });
    });
});

backend = angler.gitHttpBackend({
    pathToRepos: PATH_TO_REPOS,
    eventBus: eventBus,
    authenticator: function( params, cb ) {
        verifyAndGetRepoInfo( params.repoPath, function( err, repoInfo ) {
            var ok = !err && repoInfo,
                status = err ? 500 : ( repoInfo ? 200 : 404 );
            cb({ ok: ok, status: status });
        });
    }
});

app.use( compression() );
app.use( '/repos', backend );
app.use( '/hooks', githookEndpoint );

app.use( '/go', function( req, res ) {
    // invoked from the "go" script in client repo
    var repo = req.headers['x-gitstream-repo'];
    verifyAndGetRepoInfo( repo, function( err, repoInfo ) {
        if ( !err && repoInfo ) {
            rcon.publish( repoInfo.userId + ':go', repoInfo.exerciseName, logErr );
        } else {
            res.writeHead( 403 );
        }
        res.end();
    });
});

server = app.listen( PORT );

eventBus.addListener('name', '*', '*', function() { console.log( arguments ); });

shoe( function( stream ) {
    var events = duplexEmitter( stream ),
        exerciseMachine,
        userId = 'nhynes', // TODO: should probably get this from ssl client cert
        userKeyDeferred = q.defer(),// execute key and clientState fetches simultaneously
        userKey,
        rsub = redis.createClient(),
        FIELD_EXERCISE_STATE = 'exerciseState',
        FIELD_END_TIME = 'endTime',
        FIELD_CURRENT_EXERCISE = 'currentExercise',
        EXERCISE_CONF_FILE = 'exercise.conf';

    stream.on( 'close', function() {
        if ( exerciseMachine ) { exerciseMachine.halt(); }
        rsub.quit();
    });

    function createExerciseMachine( exerciseName ) {
        var emConfFile = path.join( PATH_TO_EXERCISES, exerciseName, EXERCISE_CONF_FILE ),
            emConf = require( emConfFile )(),
            repoMac = user.createMac( userKey, userId + exerciseName ),
            exerciseRepo = createRepoShortPath({
                userId: userId,
                exerciseName: exerciseName,
                mac: repoMac
            }),
            repoPaths = {
                fsPath: path.join( PATH_TO_REPOS, exerciseRepo ), // repo fs path
                path: exerciseRepo // repo short path
            },
            exerciseDir = path.join( PATH_TO_EXERCISES, exerciseName );
        return new ExerciseMachine( emConf, repoPaths, exerciseDir, eventBus );
    }

    /** Forward events from the exerciseMachine to the client */
    function initExerciseMachineListeners( exerciseMachine ) {
        exerciseMachine.on( 'ding', function() {
            events.emit.apply( null, [ 'ding' ].concat( arguments ) );
            rcon.hdel( userId, FIELD_EXERCISE_STATE, FIELD_END_TIME );
        });

        exerciseMachine.on( 'step', function( newState ) {
            events.emit.apply( null, [ 'step' ].concat( arguments ) );
            rcon.hset( userId, FIELD_EXERCISE_STATE, newState, logErr );
        });

        exerciseMachine.on( 'halt', function() {
            events.emit.apply( null, [ 'halt' ].concat( arguments ) );
            rcon.hdel( userId, FIELD_EXERCISE_STATE, FIELD_END_TIME );
        });
    }

    // on connect, sync the client with the stored client state
    user.getUserKey( userId, function( err, key ) {
        if ( err ) { return events.emit( 'err', err ); }
        userKey = key;
        userKeyDeferred.resolve( key );
    });

    rcon.hgetall( userId, function( err, clientState ) {
        if ( !clientState ) {
            clientState = { currentExercise: null };
            rcon.hmset( userId, clientState, logErr );
        }

        userKeyDeferred.promise.done( function( userKey ) {
            var timeRemaining = clientState.endTime - Date.now();

            if ( err ) { return events.emit( 'err', err ); }

            if ( clientState.exerciseState && timeRemaining > 0 ) {
                // there's already an excercise running. reconnect to it
                exerciseMachine = createExerciseMachine( clientState.currentExercise );
                exerciseMachine.init( clientState.exerciseState, timeRemaining / 1000 );

                initExerciseMachineListeners( exerciseMachine );
            } else if ( clientState.exerciseState ) { // last exercise has expired
                rcon.hdel( userId, FIELD_EXERCISE_STATE, FIELD_END_TIME );
                delete clientState[ FIELD_EXERCISE_STATE ];
                delete clientState[ FIELD_END_TIME ];
            }

            clientState.key = userKey;
            events.emit( 'sync', clientState );
        });
    });

    rsub.subscribe( userId + ':go' );
    rsub.on( 'message', function( channel, exerciseName ) {
        rcon.hgetall( userId, function( err, state ) {
            // only start exercise if user is on the exercise page
            if ( exerciseName !== state.currentExercise ) { return; }

            var startState;

            if ( exerciseMachine ) { exerciseMachine.halt(); } // stop the old machine
            exerciseMachine = createExerciseMachine( exerciseName );
            exerciseMachine.init();

            startState = exerciseMachine._state;

            initExerciseMachineListeners( exerciseMachine );

            rcon.hmset( userId,
                   FIELD_EXERCISE_STATE, startState,
                   FIELD_END_TIME, exerciseMachine.endTimestamp,
                   logErr );

            state[ FIELD_EXERCISE_STATE ] = startState;
            state[ FIELD_END_TIME ] = exerciseMachine.endTimestamp;

            events.emit( 'sync', state );
        });
    });

    events.on( 'exerciseChanged', function( newExercise ) {
        exerciseMachine = undefined;

        rcon.multi()
            .expire( userId, CLIENT_IDLE_TIMEOUT )
            .hdel( userId, FIELD_EXERCISE_STATE, FIELD_END_TIME )
            .hset( userId, FIELD_CURRENT_EXERCISE, newExercise )
            .exec( logErr );
    });
}).install( server, '/events' );
