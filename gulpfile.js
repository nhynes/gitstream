var gulp = require('gulp'),
    browserify = require('browserify'),
    buffer = require('vinyl-buffer'),
    cache,
    concatCss = require('gulp-concat-css'),
    hbsfy = require('hbsfy'),
    jscs,
    jshint,
    livereload,
    minifyCss = require('gulp-minify-css'),
    nodeunit,
    plumber,
    prefixer = require('gulp-autoprefixer'),
    rimraf,
    sass = require('gulp-sass'),
    source = require('vinyl-source-stream'),
    stylish,
    uglify = require('gulp-uglify'),
    watchify,

    production = process.env.NODE_ENV === 'production',

    path = {
        src: {
            all: 'src/**/*',
            js: 'src/**/*.js',
            client: {
                main: './src/client/js/main.js',
                scss: 'src/client/**/*.s[ac]ss',
                static: [
                    'src/client/resources/**/*',
                    'src/client/exercises/**/*',
                    'src/client/*.html'
                ]
            },
            exercises: 'node_modules/gitstream-exercises/exercises',
            server: 'src/server/**/*'
        },
        tests: 'test/**/*.js',
        dist: {
            base: 'dist/',
            all: 'dist/**/*',
            client: 'dist/client/',
            server: 'dist/server/',
            exercises: 'dist/server'
        },
    },

    watching;

if ( !production ) {
    cache = require('gulp-cached');
    jscs = require('gulp-jscs');
    jshint = require('gulp-jshint');
    livereload = require('gulp-livereload');
    nodeunit = require('gulp-nodeunit');
    plumber = require('gulp-plumber');
    rimraf = require('rimraf');
    stylish = require('jshint-stylish');
    watchify = require('watchify');
}

// *~ is generated by vim as temp file when saving atomically
function notilde( path ) {
    return [].concat( path, '!**/*~' );
}


gulp.task( 'clean', function( cb ) {
    return rimraf( path.dist.base, cb );
});

gulp.task( 'test', function() {
    return gulp.src( path.tests )
        .pipe( plumber())
        .pipe( nodeunit({
            reporter: 'skip_passed'
        }) );

});

gulp.task( 'checkstyle', function() {
    var stream = gulp.src( [].concat( path.src.js, path.tests ) )

    if ( !production ) {
        stream = stream
            .pipe( plumber() )
            .pipe( cache('scripts') );
    }

    return stream.pipe( jscs() )
        .pipe( jshint() )
        .pipe( jshint.reporter( stylish ) );
});

gulp.task( 'sass', function() {
    var stream = gulp.src( path.src.client.scss )

    if ( !production ) {
        stream = stream
            .pipe( plumber() )
    }

    return stream.pipe( sass() )
        .pipe( minifyCss({ cache: true }) )
        .pipe( concatCss('bundle.css') )
        .pipe( prefixer('> 5%') )
        .pipe( gulp.dest( path.dist.client ) );
});

gulp.task( 'browserify', function() {
    var bundler = browserify({
        cache: {}, packageCache: {}, fullPaths: true,
        entries: path.src.client.main,
        debug: !production
    });

    var bundle = function() {
        var stream = bundler.bundle()
            .on( 'error', function( e ) {
                console.error( '\x1b[31;1m', 'Browserify Error', e.toString(), '\x1b[0m' );
            })
            .pipe( source('bundle.js') );

        if ( production ) {
            stream = stream
                .pipe( buffer() )
                .pipe( uglify() )
        }

        stream.pipe( gulp.dest( path.dist.client ) );

        return stream;
    };

    if ( watching ) {
        bundler = watchify( bundler );
        bundler.on( 'update', bundle );
    }

    return bundle();
});

gulp.task( 'collectstatic', function() {
    var stream = gulp.src( notilde( path.src.client.static ) );

    if( !production ) {
        stream = stream.pipe( cache('static') );
    }

    return stream.pipe( gulp.dest( path.dist.client ) );
});

gulp.task( 'collectserver', function() {
    var stream = gulp.src( notilde( path.src.server ) )

    if( !production ) {
        stream = stream.pipe( cache('server') );
    }

    return stream.pipe( gulp.dest( path.dist.server ) );
});

gulp.task( 'linkexercises', function() {
    return gulp.src( path.src.exercises )
        .pipe( gulp.symlink( path.dist.exercises , { overwrite: true, relativeSymlinks: true }) );
});

gulp.task( 'watch', function() {
    livereload({ silent: true });
    watching = true;
    gulp.watch( notilde( [].concat( path.src.js, path.tests ) ), [ 'checkstyle', 'test' ] );
    gulp.watch( notilde( path.src.client.scss ), [ 'sass' ] );
    gulp.watch( notilde( path.src.client.static ), [ 'collectstatic' ] );
    gulp.watch( notilde( path.src.server ), [ 'collectserver' ] );
    return gulp.watch( path.dist.all ).on( 'change', livereload.changed );
});

gulp.task( 'build', gulp.series('sass', 'browserify', 'collectstatic', 'collectserver', 'linkexercises'), function build (cb) {
    cb();
});
gulp.task( 'default', gulp.series('checkstyle', 'test', 'watch', 'build'), function defaultTask (cb) {
    cb();
});
