// This module provides utilities that are exposed as `this` to the functions in the exercise confs

/* The ShadowBranch tracks (shadows) the tree of the local repository just
before andafter a commit. It is not valid after any other operation. */

var diff = require('diff'),
    fs = require('fs'),
    path = require('path'),
    q = require('q'),
    utils = require('./utils'),

    SHADOWBRANCH = 'refs/gitstream/shadowbranch';

// TODO: write tests
module.exports = function( config ) {
    // a new one of these is made for each new ExerciseMachine
    var repoDir = config.repoDir,
        exerciseDir = config.exerciseDir,
        exercisePath = path.resolve( exerciseDir ),
        repoPath = path.resolve( repoDir ),
        git = utils.git.bind( null, repoPath );

    function shadowFn( fn, args ) {
        var callback,
            result;
        if ( typeof args[ args.length - 1 ] === 'function' ) {
            callback = args.pop();
        }

        return git( 'checkout', [ SHADOWBRANCH ] )
        .then( fn.apply.bind( fn, null, args ) )
        .then( function( output ) {
            result = output;
            return git( 'checkout', [ 'master' ] );
        })
        .then( function() {
            return result;
        })
        .nodeify( callback );
    }

    return {
        /**
         * Compares a file in an exercise repo with a the reference file in the exercise directory
         * @param {String} verifyFilePath the path of the file to validate
         *  - relative to the exercise repo
         * @param {String} referenceFilePath the path of the file against which to validate
         *  - relative to the exercsie directory
         * @param {Function} callback Optional. err, diff or null if files identical
         * @return {Promise} if no callback is given
         */
        compareFiles: function( verifyFilePath, referenceFilePath, callback ) {
            var rfc = q.nfcall.bind( fs.readFile ),
                pathToVerified = path.join( repoDir, verifyFilePath ),
                pathToReference = path.join( exerciseDir, referenceFilePath );

            return q.all([ rfc( pathToVerified ), rfc( pathToReference ) ])
            .spread( function( verifyFile, referenceFile ) {
                var fileDiff = diff.diffLines( verifyFile, referenceFile ),
                    diffp = fileDiff.length !== 1 || fileDiff[0].added || fileDiff[0].removed;
                return diffp ? fileDiff : null;
            })
            .nodeify( callback );
        },

        /**
         * Compares a file in an exercise repo's shadowbranch
         * with a the reference file in the exercise directory
         * @see compareFiles and the description of the shadowbranch
         */
        compareFilesShadow: function() {
            return shadowFn( this.compareFiles, Array.prototype.slice.call( arguments ) );
        },

        /**
         * Diffs two refs.
         * @param {String} from the ref to be compared against
         * @param {String} to the compared ref
         * @param {Function} callback (err, diff). Optional.
         * @return {Promise} if no callback is given
         * If `to` is undefined, `from` will be compared to its parent(s).
         * If both `from` and `to` are undefined, `from` will default to HEAD
         */
        diff: function( from, to ) {
            var diffArgs = [ '-p' ],
                callback = arguments[ arguments.length - 1 ],
                cbfnp = typeof callback === 'function' ? 1 : 0;

            diffArgs.push( arguments.length < 1 + cbfnp ? 'HEAD' : from );
            if ( arguments.length >= 2 + cbfnp ) {
                diffArgs.push(to);
            }

            return git( 'diff-tree', diffArgs ).nodeify( cbfnp ? callback : null );
        },

        /**
         * diff ref shadowbranch
         * @param {String} ref the real ref. Default: HEAD
         * @param {Function} callback (err, diff). Optional.
         * @return {Promise} if no callback is given
         */
        diffShadow: function() {
            var callback = arguments[ arguments.length - 1 ],
                cbfnp = typeof callback === 'function' ? 1 : 0,
                ref = arguments.length < 1 + cbfnp ? 'HEAD' : arguments[0];

            return git( 'diff-tree', [ '-p', ref, SHADOWBRANCH ] )
            .nodeify( cbfnp ? callback : null );
        },

        /**
         * Determines whether a file contains a specified string
         * @param {String} filename the path to the searched file
         * @param {String|RegExp} needle the String or RegExp for which to search
         * @param {Function} callback (err, Boolean containsString). Optional.
         * @return {Promise} if no callback is given
         */
        fileContains: function( filename, needle, callback ) {
            var needleRegExp = needle instanceof RegExp ? needle : new RegExp( needle );
            return q.nfcall( fs.readFile, path.join( repoPath, filename ) )
            .then( function( data ) {
                return needleRegExp.test( data.toString() );
            })
            .nodeify( callback );
        },

        /**
         * Determines whether a shadowed file contains a specified string
         * @see fileContains and the description of shadow branch, above
         */
        shadowFileContains: function() {
            return shadowFn( this.fileContains, Array.prototype.slice.call( arguments ) );
        },

        /**
         * Adds the specified files (possibly templated) to the given repo and commits them
         * @param {String} repo the path to the repository. Dest files are relative to the repo root
         * @param {String} srcBase path to which src files paths are relative. Default: /
         * @param {Object} spec the specification for the commit
         *  spec: {
         *      msg: String,
         *      author: String,
         *      date: Date,
         *      files: [ 'filepath', { src: 'path', dest: 'path', template: (Object|Function) } ],
         *      // note: template and dest are optional in long-form file specs
         *   }
         * @param {Function} callback err. Optional.
         * @return {Promise} if no callback is given
         */
        addCommit: function( spec, callback ) {
            return utils.gitAddCommit( repoPath, exercisePath, spec )
            .nodeify( callback );
        },

        /**
         * Returns the log message for a specified commit
         * @param {String} ref the ref to check. Default: HEAD
         * @param {Function} callback (err, String logMsg). Optional.
         * @return {Promise} if no callback is given
         */
        getCommitMsg: function() {
            var callback = arguments[ arguments.length - 1 ],
                cbfnp = typeof callback === 'function' ? 1 : 0,
                ref = arguments[ arguments.length - 1 - cbfnp ] || 'HEAD';

            return git( 'log', [ '-n1', '--pretty="%s"', ref ] )
            .then( function( msg ) {
                return /"(.*)"\s*/.exec( msg )[1];
            })
            .nodeify( cbfnp ? callback : null );
        },

        /**
         * Parses the commit message by filtering comments and stripping whitespace
         * @param {String} commitMsg the commit message
         * @return {Array} the lines of the commit msg excluding those starting with a #
         */
        parseCommitMsg: function( commitMsg ) {
            return commitMsg.split( /\r?\n/ ).filter( function( line ) {
                return line.charAt(0) !== '#' && line.length > 0;
            }).map( function( line ) {
                return line.trim();
            });
        },

        /**
         * Determines whether a commit log message contains a specified string
         * @param {String|RegExp} needle the String or RegExp for which to search in the log message
         * @param {String} ref the ref to check. Default: HEAD
         * @param {Function} callback (err, Boolean containsString). Optional.
         * @return {Promise} if no callback is given
         */
        commitMsgContains: function( needle ) {
            var callback = arguments[ arguments.length - 1 ],
                cbfnp = typeof callback === 'function' ? 1 : 0,
                ref = arguments.length >= 2 + cbfnp ? arguments[1] : 'HEAD',
                needleRegExp = needle instanceof RegExp ? needle : new RegExp( needle );

            return this.getCommitMsg( ref )
            .then( function( msg ) {
                return needleRegExp.test( msg );
            })
            .nodeify( cbfnp ? callback : null );
        },

        /**
         * Checks for the existence of a file in the repo
         * @param {String} filename the path to the file
         * @param {Function} callback (err, Boolean fileExists). Optional
         * @return {Promise} if no callback is given
         */
        fileExists: function( filename, callback ) {
            return q.nfcall( fs.stat, path.join( repoDir, filename ) )
            .then( function() {
                return true;
            }, function( err ) {
                if ( err && err.code !== 'ENOENT' ) {
                    throw Error( err );
                } else {
                    return false;
                }
            })
            .nodeify( callback );
        },

        /**
         * Checks for the existence of a file in the repo's shadowbranch
         * @see fileExists and the description of the shadowbranch
         */
        shadowFileExists: function() {
            return shadowFn( this.fileExists, Array.prototype.slice.call( arguments ) );
        }
    };
};
